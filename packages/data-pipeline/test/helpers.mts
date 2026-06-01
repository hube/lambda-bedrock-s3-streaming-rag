import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { AwsClientStub } from "aws-sdk-client-mock";
import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";

interface S3EventBridgeEvent {
  source: string;
  "detail-type": string;
  detail: {
    bucket: { name: string };
    object: { key: string };
  };
}

export function makeEvent(
  rawKey: string,
  bucket = "test-unprocessed-bucket",
): S3EventBridgeEvent {
  return {
    source: "aws.s3",
    "detail-type": "Object Created",
    detail: {
      bucket: { name: bucket },
      object: { key: rawKey },
    },
  };
}

export function getPublishedDetail(
  ebMock: AwsClientStub<EventBridgeClient>,
  n = 0,
): Record<string, unknown> {
  const calls = ebMock.commandCalls(PutEventsCommand);
  const entry = calls[n]?.args[0].input.Entries?.[0];
  if (!entry?.Detail) throw new Error(`No PutEvents call at index ${n}`);
  return JSON.parse(entry.Detail) as Record<string, unknown>;
}

export function getPublishedEntry(
  ebMock: AwsClientStub<EventBridgeClient>,
  n = 0,
) {
  const calls = ebMock.commandCalls(PutEventsCommand);
  const entries = calls[n]?.args[0].input.Entries;
  if (!entries?.[0]) throw new Error(`No PutEvents call at index ${n}`);
  return entries[0];
}
