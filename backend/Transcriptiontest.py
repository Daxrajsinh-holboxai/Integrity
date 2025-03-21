import boto3
import os
from datetime import datetime
from botocore.exceptions import NoCredentialsError, PartialCredentialsError
import time
from dotenv import load_dotenv

# Load environment variables (AWS credentials, etc.)
# Make sure you have set the appropriate environment variables or use aws configure
# Example: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CONNECT_INSTANCE_ID
load_dotenv()
# Initialize AWS clients
connect = boto3.client('connect-contact-lens', region_name=os.getenv("AWS_REGION"))
# connect_contact_lens = boto3.client('connect-contact-lens', region_name=os.getenv("AWS_REGION"))
transcribe = boto3.client('transcribe', region_name=os.getenv("AWS_REGION"))

def fetch_analysis_segments(contact_id, instance_id, max_results, next_token=None):
    """
    Fetch real-time contact analysis segments for a given ContactId and InstanceId.
    """
    try:
        params = {
            "InstanceId": instance_id,
            "ContactId": contact_id,
            "MaxResults": max_results,
        }

        # If NextToken exists, include it for pagination
        if next_token:
            params["NextToken"] = next_token

        # Call the Amazon Connect API
        response = connect.list_realtime_contact_analysis_segments(**params)

        # Process the fetched segments
        segments = response.get("Segments", [])
        next_token = response.get("NextToken", None)

        # Format the result
        result = {
            "segments": [
                {
                    "timestamp": segment['Timestamp'],
                    "participant": segment['Transcript']['ParticipantRole'],
                    "content": segment['Transcript']['Content'],
                }
                for segment in segments
            ],
            "nextToken": next_token
        }

        return result

    except connect.exceptions.ThrottlingException:
        print("Error: Too many requests. Please try again later.")
        return None
    except (NoCredentialsError, PartialCredentialsError):
        print("Error: AWS credentials are missing or incomplete.")
        return None
    except Exception as e:
        print(f"Error fetching analysis segments: {str(e)}")
        return None

def main():
    # Get user input for the request
    print("Please provide the following details to fetch real-time contact analysis segments:\n")

    contact_id = input("Enter ContactId: ")
    instance_id = input("Enter InstanceId: ")
    max_results = int(input("Enter MaxResults (number of results to fetch): "))
    next_token = input("Enter NextToken (leave empty if none): ")
    if not next_token:
        next_token = None

    print("\nFetching analysis segments...\n")

    # Fetch the real-time analysis segments
    result = fetch_analysis_segments(contact_id, instance_id, max_results, next_token)

    # Display the result
    if result:
        print("\nFetched Segments:")
        for segment in result["segments"]:
            print(f"Timestamp: {segment['timestamp']}, Participant: {segment['participant']}, Content: {segment['content']}")
        
        if result["nextToken"]:
            print(f"\nNext Token: {result['nextToken']}")
    else:
        print("Failed to fetch analysis segments.")

if __name__ == "__main__":
    main()
