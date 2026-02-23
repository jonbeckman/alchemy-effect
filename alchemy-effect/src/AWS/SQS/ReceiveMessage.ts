import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface ReceiveMessageRequest
  extends Omit<sqs.ReceiveMessageRequest, "QueueUrl"> {}

export const ReceiveMessage = Effect.fn(function* <Q extends Queue>(queue: Q) {
  yield* bindReceiveMessage(queue);
  const QueueUrl = yield* queue.queueUrl();
  return Effect.fn("AWS.SQS.ReceiveMessage")(function* (
    request: ReceiveMessageRequest = {},
  ) {
    return yield* sqs.receiveMessage({
      ...request,
      QueueUrl: yield* QueueUrl,
    });
  });
});

export const bindReceiveMessage = Binding.fn<ReceiveMessageBinding>(
  "AWS.SQS.ReceiveMessage",
);

export class ReceiveMessageBinding extends Binding.Service(
  "AWS.SQS.ReceiveMessage",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "ReceiveMessage",
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage"],
            Resource: [Output.interpolate`${queue.queueArn()}`],
          },
        ],
      });
    }
  }),
) {}
