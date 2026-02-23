import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageRequest
  extends Omit<sqs.DeleteMessageRequest, "QueueUrl"> {}

export const DeleteMessage = Effect.fn(function* <Q extends Queue>(queue: Q) {
  yield* bindDeleteMessage(queue);
  const QueueUrl = yield* queue.queueUrl();
  return Effect.fn("AWS.SQS.DeleteMessage")(function* (
    request: DeleteMessageRequest,
  ) {
    return yield* sqs.deleteMessage({
      ...request,
      QueueUrl: yield* QueueUrl,
    });
  });
});

export const bindDeleteMessage = Binding.fn<DeleteMessageBinding>(
  "AWS.SQS.DeleteMessage",
);

export class DeleteMessageBinding extends Binding.Service(
  "AWS.SQS.DeleteMessage",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "DeleteMessage",
            Effect: "Allow",
            Action: ["sqs:DeleteMessage"],
            Resource: [Output.interpolate`${queue.queueArn()}`],
          },
        ],
      });
    }
  }),
) {}
