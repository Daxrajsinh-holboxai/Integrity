import boto3

connect = boto3.client(
    "connect",
    region_name='us-east-1'
)

response = connect.list_contacts(
    InstanceId='fce6fb63-a099-415c-a572-65639fc92612',
    ContactCategory='IN_PROGRESS'
)

print(response)