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

# Load environment variables
load_dotenv()

# Add transcription session storage
transcription_sessions = {}
call_status_store = {}
transcription_data = {}

# Initialize AWS clients
connect = boto3.client('connect', region_name=os.getenv("AWS_REGION"))
connect_cl = boto3.client('connect-contact-lens', region_name=os.getenv("AWS_REGION"))
transcribe = boto3.client('transcribe', region_name=os.getenv("AWS_REGION"))

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

call_status_store: Dict[str, dict] = {}

# Request Model
class CallRequest(BaseModel):
    phoneNumber: str

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

async def fetch_analysis_segments(contact_id: str):
    """Enhanced real-time analysis fetcher with exponential backoff"""
    instance_id = os.getenv("CONNECT_INSTANCE_ID")
    next_token = None
    retries = 0
    max_retries = 10
    
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
            
            # Process segments only if found
            if 'Segments' in response:
                for segment in response['Segments']:
                    if 'Transcript' in segment:
                        transcript = segment['Transcript']
                        if contact_id not in transcription_data:
                            transcription_data[contact_id] = []
                        transcription_data[contact_id].append({
                            'content': transcript['Content'],
                            'timestamp': datetime.now().isoformat(),
                            'participant': transcript['ParticipantRole'],
                            'offset': transcript['BeginOffsetMillis']
                        })
                print(f"Fetched {len(response['Segments'])} segments for {contact_id}")
            
            next_token = response.get('NextToken')
            if not next_token:
                break
                
            await asyncio.sleep(1)
            retries = 0  # Reset retries on success
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFoundException':
                print(f"Data not ready yet for {contact_id}, retrying... ({retries}/{max_retries})")
                retries += 1
                await asyncio.sleep(2 ** retries)  # Exponential backoff
            else:
                print(f"Client error fetching segments: {str(e)}")
                break
        except BotoCoreError as e:
            print(f"Boto core error: {str(e)}")
            break
        except Exception as e:
            print(f"Unexpected error: {str(e)}")
            break

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
            call_status_store[contact_id] = response
            
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
            TrafficType='CAMPAIGN',
        )

        contact_id = response['ContactId']
        print(contact_id)
        call_status_store[contact_id] = {
            'status': 'INITIATED',
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

        while True:
            # Get latest status and transcripts
            status = call_status_store.get(contact_id, {})
            transcripts = transcription_data.get(contact_id, [])
            
            # Sort transcripts by offset time
            sorted_transcripts = sorted(transcripts, key=lambda x: x['offset'])
            
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
            
            # Send updates to client
            await websocket.send_json(sanitize_for_json(response))
            
            # Check if call has ended
            if response["status"] in ['COMPLETED', 'FAILED']:
                await websocket.send_json({"status": "COMPLETED", "message": "Call ended"})
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