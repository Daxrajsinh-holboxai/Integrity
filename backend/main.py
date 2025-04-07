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
import openai

openai.api_key = os.getenv("OPENAI_API_KEY")


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

import json

async def process_ivr_prompt(contact_id: str, ivr_text: str):
    # Get stored row data
    row_data = call_status_store[contact_id]['row_data']
    print(f"Processing IVR prompt with row data: {row_data}")
    columns = list(row_data.keys())
    print(f"Available columns: {columns}")
    provider_details= {
        "practice_id": "10040282",
        "provider_name": "HARMONY OAKS RECOVERY CENTER, LLC",
        "npi": "1447914288",
        "tax_id": "843612075",
    }
    
    # Create an LLM prompt
    # prompt = f"""
    #     You are an assistant that extracts answers from provided data. You will be given three variables:
    #     - row_data: A JSON object containing patient details from an Excel file in the form of Key value-pair, key will be column name and value will corresponding value.
    #     - ivr_text: A string representing IVR spoken text. This text may ask the caller to provide details or instruct the caller to press a number.
    #     - provider_details: A JSON object containing provider details that might be referenced in the IVR questions.

    #     row_data: {json.dumps(row_data)}
        
    #     provider_details: {json.dumps(provider_details)}

    #     Your task is to determine which field (i.e., column name) from either row_data or provider_details corresponds to the question in segement (i.e. ivr_text), and then return the value from that field.
    #     Your response must be in the following JSON structure:
    #     {{"value": "values_value", "field": "key_value"}}
    #     - The "field" key should contain the column name (from either row_data or provider_details) that is appropriate for the question asked in segement.
    #     - The "value" key should contain the value from that column.
    #     Special Case:
    #     1. If the ivr_text explicitly instructs the caller to press a key (e.g., 'Press 1 for X', 'Press 2 for Y'), 
    #        analyze the IVR options and determine the correct number to press based on the provider or member choice (number suitable for provider is preferable). 
    #        Return the number as the 'value'. For example, if the IVR asks to press 1 if you're a provider or press 2 if you're a member, then
    #        return {{"value": "1", "field": "press a number"}}."
    #     2. If the ivr_text is irrelevant to the provided data or if no matching field can be determined, then your response should be:
    #        {{"value": "No matching data found", "field": "unknown"}}

    #     THE MOST IMPORTANT THING IS TO FOLLOW THE INSTRUCTIONS PRECISELY AND RETURN THE RESPONSE IN THE REQUIRED JSON FORMAT ONLY NOT SPARE TEXT WITH, JUST JSON FORMAT, THAT'S IT.
    # """

    prompt = f"""
        You are an advanced AI assistant designed to interpret IVR (Interactive Voice Response) prompts and extract relevant information from provided data. Your task is to analyze the IVR text and determine the appropriate response based on the given patient and provider details.

        You will be provided with three input variables:

        <row_data>
        {json.dumps(row_data)}
        </row_data>

        This is a JSON object containing patient details from an Excel file in the form of key-value pairs. The keys are column names, and the values are the corresponding data.

        <provider_details>
        {json.dumps(provider_details)}
        </provider_details>

        This is a JSON object containing provider details that might be referenced in the IVR questions.

        <ivr_text>
        {ivr_text}
        </ivr_text>

        This is a string representing the IVR spoken text. It may ask the caller to provide details, instruct the caller to press a number, or present multiple options.

        Your task is to analyze the IVR_TEXT and determine the appropriate response based on the ROW_DATA and PROVIDER_DETAILS. Follow these general rules and preferences:

        1. If there's a choice between text and audio input, prefer a choice number corresponding to text.
        2. For language preferences, always prefer a choice number for English.
        3. Pay attention to negative instructions (e.g., "NOT") and follow them precisely, For example, if said "do NOT enter your provider_id, then don't prefer giving that field and value in response".
        4. Ignore any phone numbers provided for calling. (e.g., "For emergency, call 911." then do not prefer giving that number in response).
        5. If confirmation of information is requested and the information is incorrect, respond with the number corresponding to "NO" choice.
        6. When asked for an NPI, look for the provider ID field in the provider_details.
        7. Do not enter example values provided by the IVR.
        8. If it is asked for a phone number / contact number, look for the 'payer phone' or related field from the row_data.

        Handle the following special cases and scenarios:
        These responses should in 'value' attribute of json response:
        1. Provider vs. Member/Participant choice: Always choose the provider number option when available.
        2. Numeric inputs: Enter TAX_ID, Participation ID, Health Claim ID, or Member ID as requested, using the appropriate field from row_data or provider_details.
        3. Date of Birth: Enter in the format specified by the IVR (e.g., MMDDYYYY).
        4. Reason for call: Prefer the number option for "Eligibility" or "Benefits" when asked.
        5. Healthcare provider identification: Confirm as a healthcare provider when asked by it's corresponding number.
        6. Coverage type: Choose a corresponding number option for "Medical" when asked about type of coverage.

        Your response should be in the following JSON structure:
        {{
            "value": "response_value",
            "field": "source_field"
        }}

        Where:
        - "value" is the appropriate response or action based on the IVR prompt
        - "field" is the source of the information (column name from row_data or provider_details, or "IVR_response" if it's a direct response to the IVR prompt)

        Follow this step-by-step process:

        1. Carefully read and analyze the IVR_TEXT.
        2. Identify the type of response required (e.g., numeric input, voice command, button press).
        3. Search for relevant information in ROW_DATA and PROVIDER_DETAILS.
        4. Apply the general rules and preferences to determine the appropriate response.
        5. Handle any special cases or scenarios as instructed.
        6. Formulate the response in the required JSON structure.

        Examples:

        1. IVR: "If you're a provider press 1, or if you're a member press 2."
        Response: {{"value": "1", "field": "IVR_response"}}

        2. IVR: "Please enter your 9-digit TAX_ID number followed by the pound sign."
        Response: {{"value": "123456789#", "field": "TAX_ID"}}

        3. IVR: "Please enter the patient's date of birth using 2 digits for the month, 2 digits for the day, and 4 digits for the year."
        Response: {{"value": "01011990", "field": "DOB"}}

        4. IVR: "For eligibility and benefits press 2."
        Response: {{"value": "2", "field": "IVR_response"}}

        5. IVR: "Please say your reason for calling. For example, you can say things like 'Claims' or 'Eligibility'."
        Response: {{"value": "Eligibility", "field": "IVR_response"}}

        Remember:
        - Always prioritize provider options over member options.
        - Use the most relevant and specific information from the provided data.
        - If no matching data is found or the IVR prompt is irrelevant to the provided data, respond with:
        {{"value": "No matching data found", "field": "unknown"}}
        
        THE MOST IMPORTANT THING IS TO FOLLOW THE INSTRUCTIONS PRECISELY AND RETURN THE RESPONSE IN THE REQUIRED JSON FORMAT ONLY NOT SPARE TEXT WITH, JUST JSON FORMAT, THAT'S IT.
    """ 

    # ivr_text: {ivr_text}
    try:
        # Construct the request body for Claude
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1000,
            "system": prompt,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "IVR_TEXT: " + ivr_text
                        }
                    ]
                }
            ]
        }

        # Invoke Claude via Bedrock
        response = bedrock.invoke_model(
            modelId="anthropic.claude-3-5-sonnet-20240620-v1:0",
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body)
        )

        # Parse the response
        response_body = json.loads(response['body'].read())
        generated_text = response_body['content'][0]['text']
        print("Claude Response:", generated_text)

        # Uncomment the following lines to use OpenAI instead of Bedrock
        # response = openai.chat.completions.create(
        #     model="gpt-3.5-turbo",  # Or gpt-4
        #     messages=[
        #         {"role": "system", "content": prompt},
        #         {"role": "user", "content": "IVR_TEXT: " + ivr_text}
        #     ]
        # )

        # generated_text = response.choices[0].message.content
        # print("OpenAI Response:", generated_text)

        # print(f"---------------------LLM response: {response}")

        # Parse the generated text
        try:
            parsed_output = json.loads(generated_text)
            value = parsed_output.get("value", "")
            field = parsed_output.get("field", "unknown")
        except json.JSONDecodeError:
            value = generated_text
            field = "unknown"

        return {"question": ivr_text, "value": value, "field": field}

    except Exception as e:
        print(f"Bedrock API error: {e}")
        return {"question": ivr_text, "value": "Invocation error", "field": "error"}

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
                            if response_value.get("field") == "press a number" and response_value["value"].isdigit():
                                dtmf_digits = str(response_value.get("value", ""))
                                if dtmf_digits.isdigit():
                                    response["responseSent"] = {
                                        "timestamp": datetime.now().isoformat(),
                                        "question": response_value["question"],
                                        "field": "press a number",
                                        "value": dtmf_digits
                                    }
                                    print(f"Triggering DTMF send for: {dtmf_digits}")
                                else:
                                    print(f"Invalid DTMF digits: {dtmf_digits}")
                        except ClientError as e:
                            print(f"AWS Client Error: {e.response['Error']['Message']}")
                        except Exception as e:
                            print(f"Unexpected error sending DTMF: {str(e)}")
                        
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