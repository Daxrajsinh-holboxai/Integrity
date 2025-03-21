import boto3
import os
from botocore.exceptions import ClientError

# Load environment variables from .env file
from dotenv import load_dotenv
load_dotenv()

# AWS Connect configuration
CONNECT_INSTANCE_ID = os.getenv("CONNECT_INSTANCE_ID")
AWS_REGION = os.getenv("AWS_REGION")
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")

# Initialize the boto3 client for Amazon Connect
connect_client = boto3.client(
    'connect',
    region_name=AWS_REGION,
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY
)

def stop_call(contact_id: str):
    try:
        # Call the stop_contact API to stop the ongoing call
        response = connect_client.stop_contact(
            InstanceId=CONNECT_INSTANCE_ID,
            ContactId=contact_id
        )
        
        # Check the response to confirm the operation was successful
        print(f"Call with contact ID {contact_id} has been stopped successfully.")
        print(response)
        
    except ClientError as e:
        print(f"Error stopping the call: {e}")
        if e.response['Error']['Code'] == 'ContactNotFoundException':
            print("The specified contact ID does not exist.")
        elif e.response['Error']['Code'] == 'LimitExceededException':
            print("Rate limit exceeded. Please try again later.")
        else:
            print(f"Unexpected error: {e}")

# Example usage
if __name__ == "__main__":
    contact_id = input("Enter the Contact ID to stop the call: ")
    stop_call(contact_id)
