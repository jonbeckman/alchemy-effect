import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageBatchRequest
  extends Omit<sqs.SendMessageBatchRequest, "QueueUrl"> {}

export const SendMessageBatch = Effect.fn(function* <Q extends Queue>(
  queue: Q,
) {
  yield* bindSendMessageBatch(queue);
  const QueueUrl = yield* queue.queueUrl();
  return Effect.fn("AWS.SQS.SendMessageBatch")(function* (
    request: SendMessageBatchRequest,
  ) {
    return yield* sqs.sendMessageBatch({
      ...request,
      QueueUrl: yield* QueueUrl,
    });
  });
});

export const bindSendMessageBatch = Binding.fn<SendMessageBatchBinding>(
  "AWS.SQS.SendMessageBatch",
);

export class SendMessageBatchBinding extends Binding.Service(
  "AWS.SQS.SendMessageBatch",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "SendMessageBatch",
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [Output.interpolate`${queue.queueArn()}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `SendMessageBatchBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
