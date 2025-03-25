import json
from fastapi import FastAPI, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import boto3
import os
import time
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict
from fastapi.responses import JSONResponse
from botocore.config import Config
from contextlib import asynccontextmanager
from datetime import datetime
from botocore.exceptions import ClientError, BotoCoreError
import uuid
import aioboto3
import asyncio
import hashlib
import re

# Load environment variables
load_dotenv()

# Add transcription session storage
transcription_sessions = {}
call_status_store = {}
transcription_data = {}

# Configure AWS client with custom retry policy
connect_config = Config(
    retries={
        'max_attempts': 5,
        'mode': 'adaptive',
        'total_max_attempts': 10,
    }
)

connect = boto3.client(
    "connect",
    config=connect_config,
    region_name=os.getenv("AWS_REGION"),
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)
# Initialize AWS clients
connect_cl = boto3.client(
    'connect-contact-lens',
    region_name=os.getenv("AWS_REGION"),
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY")
)

bedrock = boto3.client(
    service_name='bedrock-runtime',
    region_name=os.getenv("AWS_REGION"),
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY")
)

# participant_client = boto3.client(
#     'connectparticipant',
#     region_name=os.getenv("AWS_REGION"),
#     aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
#     aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY")
# )

# transcribe = boto3.client('transcribe', region_name=os.getenv("AWS_REGION"))

def hash_segment(content: str) -> str:
    """Generate a hash for content after normalizing whitespace and case."""
    normalized = " ".join(content.strip().lower().split())
    return hashlib.sha256(normalized.encode()).hexdigest()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Cleanup resources on shutdown
    yield
    for session in transcription_sessions.values():
        await session.close()

# Initialize FastAPI app
app = FastAPI(lifespan=lifespan)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins (update for production)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

call_status_store: Dict[str, dict] = {}

# Request Model
class CallRequest(BaseModel):
    phoneNumber: str
    rowData: dict

class CallStatusRequest(BaseModel):
    contact_id: str

def sanitize_for_json(obj):
    if isinstance(obj, dict):
        return {k: sanitize_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [sanitize_for_json(v) for v in obj]
    elif isinstance(obj, datetime):
        return obj.isoformat()
    return obj

@app.post("/fetch-call-transcript/{contact_id}")
async def fetch_analysis_segments(contact_id: str):
    instance_id = os.getenv("CONNECT_INSTANCE_ID")
    next_token = None
    retries = 0
    max_retries = 10
    seen_hashes = set()

    while retries < max_retries:
        try:
            params = {
                "InstanceId": instance_id,
                "ContactId": contact_id,
                "MaxResults": 100
            }
            if next_token:
                params["NextToken"] = next_token

            response = connect_cl.list_realtime_contact_analysis_segments(**params)
            segments = response.get("Segments", [])
            next_token = response.get("NextToken")

            for segment in segments:
                if 'Transcript' not in segment:
                    continue
                transcript = segment['Transcript']
                content = transcript['Content'].strip()

                # Generate a hash to detect duplicate content
                content_hash = hash_segment(content)

                if contact_id not in transcription_data:
                    transcription_data[contact_id] = []
                    seen_hashes = set()
                
                # Avoid duplicate segments by hash
                if content_hash in seen_hashes:
                    continue

                seen_hashes.add(content_hash)

                transcription_data[contact_id].append({
                    'content': content,
                    'timestamp': datetime.now().isoformat(),
                    'participant': transcript['ParticipantRole'],
                    'offset': transcript['BeginOffsetMillis']
                })

            print(f"Fetched {len(segments)} segments for {contact_id}")
            if not next_token:
                break

            await asyncio.sleep(1)
            retries = 0

        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFoundException':
                print(f"Data not ready yet for {contact_id}, retrying... ({retries}/{max_retries})")
                retries += 1
                await asyncio.sleep(2 ** retries)
            else:
                print(f"Client error: {e}")
                break
        except Exception as e:
            print(f"Unexpected error: {e}")
            break

def clean_transcripts(transcripts):
    seen = set()
    cleaned = []
    for t in transcripts:
        key = (t['participant'], t['content'].strip())
        if key not in seen:
            seen.add(key)
            cleaned.append(t)
    return cleaned

def poll_contact_attributes(contact_id: str):
    """Poll contact attributes independently"""
    while True:
        try:
            response = connect.get_contact_attributes(
                InstanceId=os.getenv("CONNECT_INSTANCE_ID"),
                ContactId=contact_id
            )
            # Update call status store
            if contact_id in call_status_store:
                call_status_store[contact_id]['Attributes'] = response['Attributes']
            time.sleep(2)
        except Exception as e:
            print(f"Attribute poll error: {e}")
            break

async def process_ivr_prompt(contact_id: str, ivr_text: str):
        # Get stored row data
        row_data = call_status_store[contact_id]['row_data']
        print(f"Processing IVR prompt with row data: {row_data}")
        columns = list(row_data.keys())
        print(f"Available columns: {columns}")
        
        # Create LLM prompt
        prompt = f"""
            You are a smart assistant that helps answer customer questions based on a given record (row) of data. 
            You will be provided:
            - a sentence spoken by the customer,
            - a record containing row data.

            Your job is to:
            1. Identify which key in the record best answers the customer's sentence.
            2. Return a structured JSON with:
                - "question": the original customer sentence,
                - "field": the exact key from the record that answers the question,
                - "value": the value from that key.             
            3. If customer asks to press a number, then return the response in value "Please enter a number" and return a proper json format mentioned.
            Remember -> Return ONLY a valid JSON object in the following structure:
                {{
                "question": "<customer sentence>",
                "field": "<exact field name or 'none'>",
                "value": "<value from the record or 'not found'>"
                }}  

            If none of the fields are relevant to the customer's question, return:
            {{"question": "<original>", "field": "none", "value": "not found"}}

            Customer sentence:
            {ivr_text}

            Record:
            {json.dumps(row_data, indent=2)}
            """
        
        # Call Titan LLM
        response = bedrock.invoke_model(
            modelId='amazon.titan-text-express-v1',
            body=json.dumps({
                "inputText": prompt,
                "textGenerationConfig": {
                    "maxTokenCount": 100,
                    "temperature": 0.0,
                    "topP": 0.9         
                }
            })
        )
        
        result = json.loads(response['body'].read())
        response_text = result['results'][0]['outputText'].strip()
        print(f"LLM response: {response_text}")
        try:
            parsed = json.loads(response_text)
            
            field_name = parsed.get("field", "").strip()
            if field_name.lower() == "none":
                return {"field": "none", "value": "not found", "question": ivr_text}
        except json.JSONDecodeError:
            print(f"LLM output was not valid JSON:\n{response_text}")

            # # Try extracting JSON-looking content from text using regex
            # match = re.search(r"\{.*?\}", response_text, re.DOTALL)
            # if match:
            #     json_str = match.group(0)
            #     try:
            #         parsed = json.loads(json_str)
            #         field_name = parsed.get("field", "").strip()
            #         if field_name.lower() == "none":
            #             return {"field": "none", "value": "not found", "question": ivr_text}
            #         else:
            #             return parsed
            #     except Exception as inner_e:
            #         print(f"Fallback JSON parse failed: {inner_e} | Raw: {json_str}")
            #         return {"field": "error", "value": "failed to parse", "question": ivr_text}
            return {"question": ivr_text, "value": response_text, "field": "unknown"}

        
            # Normalize and match field name
            field_key_map = {k.strip().lower().replace(" ", "_"): k for k in row_data}
            normalized_field = field_name.strip().lower().replace(" ", "_")

            if normalized_field in field_key_map:
                actual_key = field_key_map[normalized_field]
                return {
                    "field": actual_key,
                    "value": row_data[actual_key],
                    "question": ivr_text
                }
            else:
                return {"field": "unknown", "value": "not found", "question": ivr_text}
        except Exception as e:
            print(f"LLM parsing error: {e}, raw response: {response_text}")
            return {"field": "error", "value": "failed to parse", "question": ivr_text}


async def start_transcription_process(contact_id: str):
    """Start transcription with proper async implementation"""
    print(f"Starting transcription process for contact {contact_id}")
    
    # Check if we already have a session for this contact
    if contact_id in transcription_sessions:
        print(f"Transcription session already exists for {contact_id}")
        return
    
    # Create a placeholder for the transcript
    transcription_sessions[contact_id] = {
        'transcript': 'Initializing transcription...\n',
        'status': 'starting'
    }
    
    try:
        # In a real implementation, you would connect to the Amazon Connect 
        # voice stream here and send it to Amazon Transcribe.
        # For now, let's simulate transcription with placeholder text
        # to fix the immediate issues
        
        # Mark the session as active
        transcription_sessions[contact_id]['status'] = 'active'
        
        # Simulate IVR messages with timestamps
        await asyncio.sleep(2)
        current_time = datetime.now().strftime("%H:%M:%S")
        transcription_sessions[contact_id]['transcript'] += f"[{current_time}] IVR: Thank you for calling. Your call is important to us.\n"
        
        await asyncio.sleep(3)
        current_time = datetime.now().strftime("%H:%M:%S")
        transcription_sessions[contact_id]['transcript'] += f"[{current_time}] IVR: Please wait while we connect you to our system.\n"
        
        await asyncio.sleep(3)
        current_time = datetime.now().strftime("%H:%M:%S")
        transcription_sessions[contact_id]['transcript'] += f"[{current_time}] IVR: For quality and training purposes, this call may be recorded.\n"
        
        # Keep the transcription session active until the call ends
        call_active = True
        while call_active:
            status = call_status_store.get(contact_id, {}).get('ContactStatus')
            if status in ['COMPLETED', 'FAILED', None]:
                call_active = False
            await asyncio.sleep(1)
            
    except Exception as e:
        print(f"Transcription error: {str(e)}")
        transcription_sessions[contact_id]['transcript'] += f"Error in transcription: {str(e)}\n"
    finally:
        # Mark the session as complete but keep the transcript
        if contact_id in transcription_sessions:
            transcription_sessions[contact_id]['status'] = 'completed'
            current_time = datetime.now().strftime("%H:%M:%S")
            transcription_sessions[contact_id]['transcript'] += f"[{current_time}] Transcription ended.\n"

# Modify the poll_call_status function to run in an async context
# Modified poll_call_status to ensure real-time analysis starts
async def poll_call_status(contact_id: str):
    """Enhanced status polling with real-time analysis initiation"""
    max_retries = 60
    for _ in range(max_retries):
        try:
            response = connect.describe_contact(
                InstanceId=os.getenv("CONNECT_INSTANCE_ID"),
                ContactId=contact_id
            )
            
            current_status = response.get('ContactStatus', 'INITIATED')
            # Merge existing data with new response
            call_status_store[contact_id] = {
                **call_status_store.get(contact_id, {}),
                **response
            }
            
            # Automatically start transcription when call connects
            if current_status in ['CONNECTED', 'IN_PROGRESS'] and contact_id not in transcription_data:
                print(f"Starting real-time analysis for {contact_id}")
                asyncio.create_task(fetch_analysis_segments(contact_id))
            
            if current_status in ['COMPLETED', 'FAILED']:
                break
                
            await asyncio.sleep(2)
            
        except Exception as e:
            print(f"Status check error: {str(e)}")
            await asyncio.sleep(2)

# Add this error handler for better logging
@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    print(f"Unhandled exception: {str(exc)}")
    return JSONResponse(
        status_code=500,
        content={"message": "Internal server error"}
    )

@app.post("/initiate-call")
async def initiate_call(request: CallRequest):
    try:
        response = connect.start_outbound_voice_contact(
            InstanceId=os.getenv("CONNECT_INSTANCE_ID"),
            ContactFlowId=os.getenv("CONTACT_FLOW_ID"),
            DestinationPhoneNumber=request.phoneNumber,
            SourcePhoneNumber=os.getenv("SOURCE_PHONE_NUMBER"),
            QueueId=os.getenv("QUEUE_ID"),
            Attributes={  # Critical for transcription
                "AWSContactLensEnabled": "true",
                "LanguageCode": "en-US"
            }
        )

        contact_id = response['ContactId']
        print(contact_id)
        call_status_store[contact_id] = {
            'status': 'INITIATED',
            'row_data': request.rowData,
            'ContactStatus': 'INITIATED',
            'timestamp': datetime.now(),
        }
        
        asyncio.create_task(poll_call_status(contact_id))
        
        return {
            "success": True,
            "contact_id": contact_id,
            "message": "Call queued successfully"
        }
    except Exception as error:
        raise HTTPException(status_code=500, detail={"success": False, "error": str(error)})

@app.websocket("/ws/{contact_id}")
async def websocket_endpoint(websocket: WebSocket, contact_id: str):
    await websocket.accept()
    poll_task = None
    
    try:
        # Start background polling task
        async def background_poller():
            while True:
                try:
                    await fetch_analysis_segments(contact_id)
                    status = call_status_store.get(contact_id, {})
                    if status.get('ContactStatus') in ['COMPLETED', 'FAILED']:
                        break
                    await asyncio.sleep(2)
                except Exception as e:
                    print(f"Background poll error: {str(e)}")
                    break
        
        poll_task = asyncio.create_task(background_poller())
        processed_prompt_hashes = set()


        while True:
            # Get latest status and transcripts
            status = call_status_store.get(contact_id, {})
            transcripts = transcription_data.get(contact_id, [])
            
            # Sort transcripts by offset time
            sorted_transcripts = sorted(clean_transcripts(transcripts), key=lambda x: x['offset'])
            
            # Format transcript for display
            formatted_transcript = "\n".join(
                [f"[{datetime.fromisoformat(t['timestamp']).strftime('%H:%M:%S')}] "
                 f"{t['participant']}: {t['content']}" 
                 for t in sorted_transcripts]
            )
            
            # Prepare response
            response = {
                "status": status.get('ContactStatus', 'UNKNOWN'),
                "transcript": formatted_transcript,
                "timestamp": datetime.now().isoformat(),
                "ivr_connected": status.get('ContactStatus') in ['CONNECTED', 'IN_PROGRESS'],
                "attributes": status.get('Attributes', {})
            }

             # Process new IVR prompts
            for t in sorted_transcripts:
                if t['participant'] == 'CUSTOMER':
                    prompt_hash = hash_segment(t['content'])
                    if prompt_hash in processed_prompt_hashes:
                        continue
                    processed_prompt_hashes.add(prompt_hash)
                    response_value = await process_ivr_prompt(contact_id, t['content'])
                    if response_value:
                        try:
                            # Use Amazon Connect participant API instead
                            participant_response = connect.get_contact_attributes(
                                InstanceId=os.getenv("CONNECT_INSTANCE_ID"),
                                ContactId=contact_id
                            )
                            participant_id = participant_response['Attributes'].get('participantId')
                            
                            # if participant_id:
                            #     connect.send_dtmf(
                            #         InstanceId=os.getenv("CONNECT_INSTANCE_ID"),
                            #         InitialContactId=contact_id,
                            #         ParticipantId=participant_id,
                            #         InputDigits=str(response_value)
                            #     )
                        except Exception as e:
                            print(f"DTMF sending error: {str(e)}")
                        
                        response["responseSent"] = {
                            "timestamp": datetime.now().isoformat(),
                            "question": response_value["question"],
                            "field": response_value["field"],
                            "value": response_value["value"]
                        }

            
            # Send updates to client
            await websocket.send_json(sanitize_for_json(response))
            
            # Check if call has ended
            if response["status"] in ['COMPLETED', 'FAILED']:
                await websocket.send_json({"status": "COMPLETED", "message": "Call ended"})
                
                if contact_id in transcription_data:
                    del transcription_data[contact_id]
                if contact_id in transcription_sessions:
                    del transcription_sessions[contact_id]
                
                break

                
            await asyncio.sleep(0.5)
            
    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"WebSocket error: {str(e)}")
    finally:
        if poll_task:
            poll_task.cancel()
        if contact_id in transcription_data:
            del transcription_data[contact_id]

@app.get("/call-status/{contact_id}")
async def get_call_status(contact_id: str):
    if contact_id not in call_status_store:
        raise HTTPException(status_code=404, detail="Contact ID not found")
    return call_status_store[contact_id]
    
# Modified transcription handling
async def handle_transcription(contact_id):
    session = aioboto3.Session()
    transcribe = session.client('transcribe-streaming', region_name=os.getenv("AWS_REGION"))
    
    try:
        stream = await transcribe.start_stream_transcription(
            LanguageCode='en-US',
            MediaEncoding='pcm',
            MediaSampleRateHertz=8000,
            EnableChannelIdentification=True,
            NumberOfChannels=1,
        )
        
        transcription_sessions[contact_id] = {
            'stream': stream,
            'transcript': ''
        }
        
        async for event in stream.TranscriptResultStream:
            results = event['Transcript']['Results']
            if results:
                transcript = results[0]['Alternatives'][0]['Transcript']
                transcription_sessions[contact_id]['transcript'] += transcript + ' '
                
    except Exception as e:
        print(f"Transcription error: {str(e)}")
    finally:
        if contact_id in transcription_sessions:
            del transcription_sessions[contact_id]

# Run the server
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)