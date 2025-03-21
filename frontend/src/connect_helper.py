# connect_helper.py
import boto3
import os
import time
import asyncio
from typing import Dict, Any, Optional
import aioboto3
from botocore.config import Config
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure AWS client with custom retry policy
connect_config = Config(
    retries={
        'max_attempts': 5,
        'mode': 'adaptive',
        'total_max_attempts': 10,
    }
)

class ConnectHelper:
    def __init__(self):
        self.connect = boto3.client(
            "connect",
            config=connect_config,
            region_name=os.getenv("AWS_REGION"),
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        )
        self.instance_id = os.getenv("CONNECT_INSTANCE_ID")
        self.contact_flow_id = os.getenv("CONTACT_FLOW_ID")
        self.source_phone = os.getenv("SOURCE_PHONE_NUMBER")
        
    def initiate_call(self, phone_number: str) -> Dict[str, Any]:
        """Initiate a call to the specified phone number"""
        try:
            response = self.connect.start_outbound_voice_contact(
                InstanceId=self.instance_id,
                ContactFlowId=self.contact_flow_id,
                DestinationPhoneNumber=phone_number,
                SourcePhoneNumber=self.source_phone,
                TrafficType='CAMPAIGN',
            )
            return {
                "success": True,
                "contact_id": response['ContactId'],
                "message": "Call initiated successfully"
            }
        except Exception as e:
            raise e
    
    def get_contact_status(self, contact_id: str) -> Dict[str, Any]:
        """Get the current status of a contact"""
        return self.connect.describe_contact(
            InstanceId=self.instance_id,
            ContactId=contact_id
        )
    
    def get_contact_attributes(self, contact_id: str) -> Dict[str, Any]:
        """Get the attributes of a contact"""
        return self.connect.get_contact_attributes(
            InstanceId=self.instance_id,
            ContactId=contact_id
        )
    
    async def monitor_for_connection(self, contact_id: str, callback=None) -> None:
        """Monitor a contact for connection to IVR and call the callback when connected"""
        max_attempts = 60
        for _ in range(max_attempts):
            try:
                status = self.get_contact_status(contact_id)
                current_status = status.get('ContactStatus')
                
                if current_status == 'CONNECTED':
                    if callback:
                        # Execute callback when connected
                        await callback(contact_id, status)
                    return True
                
                if current_status in ['COMPLETED', 'FAILED']:
                    return False
                
                await asyncio.sleep(1)
            except Exception as e:
                print(f"Error monitoring contact: {str(e)}")
                await asyncio.sleep(1)
        
        return False

class TranscribeHelper:
    def __init__(self):
        self.region = os.getenv("AWS_REGION")
        self.access_key = os.getenv("AWS_ACCESS_KEY_ID")
        self.secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
        self.sessions = {}
    
    async def start_transcription(self, contact_id: str):
        """Start transcription for a contact"""
        session = aioboto3.Session()
        
        try:
            async with session.client(
                'transcribe-streaming',
                region_name=self.region,
                aws_access_key_id=self.access_key,
                aws_secret_access_key=self.secret_key
            ) as transcribe_client:
                
                # Configure transcription settings optimized for IVR
                stream = await transcribe_client.start_stream_transcription(
                    LanguageCode='en-US',
                    MediaEncoding='pcm',
                    MediaSampleRateHertz=8000,
                    EnableChannelIdentification=True,
                    NumberOfChannels=2,
                    VocabularyFilterMethod='mask',  # Optional: mask sensitive information
                )
                
                self.sessions[contact_id] = {
                    'stream': stream,
                    'transcript': '',
                    'start_time': time.time()
                }
                
                # Process incoming transcription results
                async for event in stream.TranscriptResultStream:
                    if 'Transcript' in event:
                        results = event['Transcript'].get('Results', [])
                        
                        for result in results:
                            if result.get('IsPartial', True) is False:
                                # Only process complete segments
                                for alt in result.get('Alternatives', []):
                                    transcript = alt.get('Transcript', '')
                                    
                                    if transcript.strip():
                                        # Add to transcript with timestamp
                                        elapsed = time.time() - self.sessions[contact_id]['start_time']
                                        timestamp = time.strftime("%M:%S", time.gmtime(elapsed))
                                        
                                        channel = result.get('ChannelId', '0')
                                        speaker = "IVR" if channel == "0" else "User"
                                        
                                        formatted = f"[{timestamp}] {speaker}: {transcript}"
                                        self.sessions[contact_id]['transcript'] += formatted + '\n'
                
                return self.sessions[contact_id]['transcript']
        except Exception as e:
            print(f"Transcription error: {str(e)}")
            return None
        finally:
            # Cleanup but keep the transcript
            if contact_id in self.sessions:
                if 'stream' in self.sessions[contact_id]:
                    await self.sessions[contact_id]['stream'].close()
                    
    def get_transcript(self, contact_id: str) -> Optional[str]:
        """Get the current transcript for a contact"""
        if contact_id in self.sessions:
            return self.sessions[contact_id].get('transcript', '')
        return None