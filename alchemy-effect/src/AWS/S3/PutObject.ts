import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

export const PutObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindPutObject(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.PutObject")(function* (request: PutObjectRequest) {
    return yield* S3.putObject({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindPutObject = Binding.fn<PutObjectBinding>(
  "AWS.S3.PutObject",
);

export class PutObjectBinding extends Binding.Service(
  "AWS.S3.PutObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "PutObject",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `PutObjectBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
