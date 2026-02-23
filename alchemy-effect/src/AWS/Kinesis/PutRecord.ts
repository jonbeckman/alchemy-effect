import * as Kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordRequest<S extends Stream> extends Omit<
  Kinesis.PutRecordInput,
  "StreamName" | "Data"
> {
  Data: S["props"]["schema"]["Type"];
}

export const PutRecord = Effect.fn(function* <S extends Stream>(stream: S) {
  yield* bindPutRecord(stream);
  const StreamName = yield* stream.streamName();
  Effect.fn("AWS.Kinesis.PutRecord")(function* (request: PutRecordRequest<S>) {
    return yield* Kinesis.putRecord({
      ...request,
      StreamName: yield* StreamName,
      Data: new TextEncoder().encode(JSON.stringify(request.Data)),
    });
  });
});

export const bindPutRecord = Binding.fn<PutRecordBinding>(
  "AWS.Kinesis.PutRecord",
);

export class PutRecordBinding extends Binding.Service(
  "AWS.Kinesis.PutRecord",
  Effect.fn(function* <S extends Stream>(stream: S) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "PutRecord",
            Effect: "Allow",
            Action: ["kinesis:PutRecord"],
            Resource: [Output.interpolate`${stream.streamArn()}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `PutRecordBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
