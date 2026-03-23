// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { BedrockEmbeddings, ChatBedrockConverse } from "@langchain/aws";
import * as lancedb from "@lancedb/lancedb";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

const lanceDbSrc = process.env.s3BucketName;
const lanceDbTable = process.env.lanceDbTable;
const awsRegion = process.env.region;


const runChain = async ({query, model, streamingFormat}, responseStream) => {
    const lanceDbS3Uri = `s3://${lanceDbSrc}/`;

    console.log('lanceDbS3Uri', lanceDbS3Uri);
    console.log('lanceDbTable', lanceDbTable);
    console.log('awsRegion', awsRegion);
    console.log('query', query);
    console.log('model', model);
    console.log('streamingFormat', streamingFormat);

    const db = await lancedb.connect(lanceDbS3Uri);
    const table = await db.openTable(lanceDbTable);

    const embeddings = new BedrockEmbeddings({region:awsRegion});
    const queryEmbedding = await embeddings.embedQuery(query);
    const results = await table.query().nearestTo(queryEmbedding).limit(4).toArray();
    const context = results.map(r => r.text).filter(Boolean).join('\n\n');
    console.log('retrieved chunks', results.length);

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

    const chain = prompt.pipe(llmModel).pipe(new StringOutputParser());
    const stream = await chain.stream({ context, question: query });
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
