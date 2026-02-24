import * as Kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordsRequest extends Omit<
  Kinesis.PutRecordsInput,
  "StreamName"
> {}

export const PutRecords = Effect.fn(function* <S extends Stream>(stream: S) {
  yield* bindPutRecords(stream);
  const StreamName = yield* stream.streamName();
  return yield* AWS.withContext(
    Effect.fn(function* (request: PutRecordsRequest) {
      return yield* Kinesis.putRecords({
        ...request,
        StreamName: yield* StreamName,
      });
    }),
  );
});

export const bindPutRecords = Binding.fn<PutRecordsBinding>(
  "AWS.Kinesis.PutRecords",
);

export class PutRecordsBinding extends Binding.Service(
  "AWS.Kinesis.PutRecords",
  Effect.fn(function* <S extends Stream>(stream: S) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "PutRecords",
            Effect: "Allow",
            Action: ["kinesis:PutRecords"],
            Resource: [Output.interpolate`${stream.streamArn()}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `PutRecordsBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
