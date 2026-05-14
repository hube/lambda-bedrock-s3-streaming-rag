import type { Context } from "aws-lambda";
import type { Writable } from "node:stream";

declare global {
  namespace awslambda {
    type ResponseStream = Writable & {
      setContentType(contentType: string): void;
    };

    function streamifyResponse<E, R = void>(
      handler: (
        event: E,
        responseStream: ResponseStream,
        context: Context,
      ) => Promise<R>,
    ): (event: E, context: Context) => Promise<R>;
  }
}

export {};
