# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import glob
import os
import sys
import tempfile

import boto3
from langchain_aws.embeddings import BedrockEmbeddings
from langchain_community.document_loaders import PyPDFDirectoryLoader, PyPDFLoader
from langchain_community.vectorstores import LanceDB
from langchain_text_splitters import CharacterTextSplitter

BUCKET_NAME = os.environ.get("s3BucketName")
REGION = os.environ.get("region", "us-east-1")
TABLE_NAME = os.environ.get("lanceDbTable", "vectorstore")
DOCS_DIR = os.environ.get("DOCS_DIR", "./docs")

text_splitter = CharacterTextSplitter(chunk_size=1000, chunk_overlap=200)


def _ingest(docs: list) -> int:
    """Embed docs and write them into the LanceDB table on S3."""
    if not BUCKET_NAME:
        raise ValueError("s3BucketName environment variable is not set")

    chunks = text_splitter.split_documents(docs)
    embeddings = BedrockEmbeddings(region_name=REGION)
    db = LanceDB(
        uri=f"s3://{BUCKET_NAME}/",
        embedding=embeddings,
        table_name=TABLE_NAME,
    )
    db.add_documents(chunks)
    return len(chunks)


def handler(event, context):
    """Lambda handler — triggered by S3 ObjectCreated events for PDF uploads."""
    s3 = boto3.client("s3", region_name=REGION)
    records = event.get("Records", [])

    docs = []
    for record in records:
        src_bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]

        if not key.lower().endswith(".pdf"):
            print(f"Skipping non-PDF key: {key}")
            continue

        tmp_path = os.path.join(tempfile.gettempdir(), os.path.basename(key))
        print(f"Downloading s3://{src_bucket}/{key} -> {tmp_path}")
        s3.download_file(src_bucket, key, tmp_path)
        docs.extend(PyPDFLoader(tmp_path).load())

    if not docs:
        print("No PDF documents found in event records.")
        return {"statusCode": 200, "body": "No documents ingested."}

    count = _ingest(docs)
    msg = f"Ingested {count} chunks from {len(records)} record(s) into s3://{BUCKET_NAME}/ table={TABLE_NAME}"
    print(msg)
    return {"statusCode": 200, "body": msg}


if __name__ == "__main__":
    # Local CLI usage: reads PDFs from DOCS_DIR and writes directly to S3.
    # Required env vars: s3BucketName, region (optional, defaults to us-east-1)
    pdf_files = glob.glob(os.path.join(DOCS_DIR, "*.pdf"))
    if not pdf_files:
        print(f"Error: No PDF files found in {DOCS_DIR}")
        sys.exit(1)

    print(f"Ingesting {len(pdf_files)} document(s): {pdf_files}")
    docs = PyPDFDirectoryLoader(DOCS_DIR).load()
    count = _ingest(docs)
    print(f"Done. Ingested {count} chunks into s3://{BUCKET_NAME}/ table={TABLE_NAME}")
