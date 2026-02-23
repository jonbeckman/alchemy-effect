import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface AbortMultipartUploadRequest extends Omit<
  S3.AbortMultipartUploadRequest,
  "Bucket"
> {}

export const AbortMultipartUpload = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindAbortMultipartUpload(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.AbortMultipartUpload")(function* (request: AbortMultipartUploadRequest) {
    return yield* S3.abortMultipartUpload({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindAbortMultipartUpload = Binding.fn<AbortMultipartUploadBinding>(
  "AWS.S3.AbortMultipartUpload",
);

export class AbortMultipartUploadBinding extends Binding.Service(
  "AWS.S3.AbortMultipartUpload",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "AbortMultipartUpload",
            Effect: "Allow",
            Action: ["s3:AbortMultipartUpload"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `AbortMultipartUploadBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
