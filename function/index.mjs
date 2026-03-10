// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { LanceDB } from "@langchain/community/vectorstores/lancedb";
import { BedrockEmbeddings, ChatBedrockConverse } from "@langchain/aws";
import * as lancedb from "@lancedb/lancedb";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence, RunnablePassthrough } from "@langchain/core/runnables";
import { formatDocumentsAsString } from "@langchain/classic/util/document";

const lanceDbSrc = process.env.s3BucketName;
const lanceDbTable = process.env.lanceDbTable;
const awsRegion = process.env.region;


const runChain = async ({query, model, streamingFormat}, responseStream) => {
    const db = await lancedb.connect(`s3://${lanceDbSrc}/`);
    const table = await db.openTable(lanceDbTable);
    console.log('query', query);
    console.log('model', model);
    console.log('streamingFormat', streamingFormat);

    const embeddings = new BedrockEmbeddings({region:awsRegion});
    const vectorStore = new LanceDB(embeddings, {table});
    const retriever = vectorStore.asRetriever();

    const prompt = PromptTemplate.fromTemplate(
        `Answer the following question based only on the following context:
        {context}

        Question: {question}`
    );

    const llmModel = new ChatBedrockConverse({
        model: model || 'us.anthropic.claude-sonnet-4-6',
        region: awsRegion,
        streaming: true,
        maxTokens: 1000,
    });

    const chain = RunnableSequence.from([
        {
            context: retriever.pipe(formatDocumentsAsString),
            question: new RunnablePassthrough()
        },
        prompt,
        llmModel,
        new StringOutputParser()
    ]);

    const stream = await chain.stream(query);
    for await (const chunk of stream){
        console.log(chunk);
        switch (streamingFormat) {
            case 'fetch-event-source':
                responseStream.write(`event: message\n`);
                responseStream.write(`data: ${chunk}\n\n`);
                break;
            default:
                responseStream.write(chunk);
                break;
        }
    }
    responseStream.end();

  };

function parseBase64(message) {
    return JSON.parse(Buffer.from(message, "base64").toString("utf-8"));
}

export const handler = awslambda.streamifyResponse(async (event, responseStream, _context) => {
    console.log("Event is %o", event);
    let body;
    if (event.body) {
        body = event.isBase64Encoded ? parseBase64(event.body) : JSON.parse(event.body);
    } else {
        body = event;
    }
    await runChain(body, responseStream);
    console.log(JSON.stringify({"status": "complete"}));
});

/*
Sample event 1:
{
    "query": "What models are available in Amazon Bedrock?",
}
Sample event 2:
{
    "query": "What models are available in Amazon Bedrock?",
    "model": "us.anthropic.claude-sonnet-4-6"
}
Sample event 3:
{
    "query": "What models are available in Amazon Bedrock?",
    "model": "us.anthropic.claude-sonnet-4-6",
    "streamingFormat": "fetch-event-source"
}
*/
