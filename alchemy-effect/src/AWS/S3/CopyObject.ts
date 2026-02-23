import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CopyObjectRequest extends Omit<
  S3.CopyObjectRequest,
  "Bucket"
> {}

export const CopyObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindCopyObject(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.CopyObject")(function* (request: CopyObjectRequest) {
    return yield* S3.copyObject({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindCopyObject = Binding.fn<CopyObjectBinding>(
  "AWS.S3.CopyObject",
);

export class CopyObjectBinding extends Binding.Service(
  "AWS.S3.CopyObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "CopyObject",
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `CopyObjectBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
