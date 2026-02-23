import * as SQS from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import type * as S from "effect/Schema";
import * as Sink from "effect/Sink";

import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export const sink = Effect.fn(function* <Q extends Queue>(queue: Q) {
  yield* Binding.fn<QueueSink>("AWS.SQS.QueueSink")(queue);
  const QueueUrl = yield* queue.queueUrl();
  return Sink.forEachArray(
    Effect.fnUntraced(function* (messages) {
      yield* SQS.sendMessageBatch({
        QueueUrl: yield* QueueUrl,
        Entries: messages.map(
          (message: S.Schema.Type<Q["props"]["schema"]>) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.value),
          }),
        ),
      }).pipe(Effect.ignore);
    }),
  );
});

export class QueueSink extends Binding.Service(
  "AWS.SQS.QueueSink",
  Effect.fn(function* (queue: Queue) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "QueueSink",
            Effect: "Allow",
            Action: ["sqs:SendMessageBatch"],
            Resource: [Output.interpolate`${queue.queueArn()}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `QueueSinkBinding requires a Lambda Function runtime`,
    );
  }),
) {}
