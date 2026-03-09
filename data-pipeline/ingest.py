# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import os

from langchain_aws.embeddings import BedrockEmbeddings
from langchain_community.document_loaders import PyPDFDirectoryLoader
from langchain_community.vectorstores import LanceDB
from langchain_text_splitters import CharacterTextSplitter

import lancedb as ldb

# we split the data into chunks of 1,000 characters, with an overlap
# of 200 characters between the chunks, which helps to give better results
# and contain the context of the information between chunks
text_splitter = CharacterTextSplitter(chunk_size=1000, chunk_overlap=200)

# load the document as before

loader = PyPDFDirectoryLoader("./docs/")

docs = loader.load()
docs = text_splitter.split_documents(docs)

db = LanceDB(uri="/tmp/embeddings", embedding=BedrockEmbeddings())
db.add_documents(docs)
