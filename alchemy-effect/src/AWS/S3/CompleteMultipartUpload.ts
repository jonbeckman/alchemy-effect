import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CompleteMultipartUploadRequest extends Omit<
  S3.CompleteMultipartUploadRequest,
  "Bucket"
> {}

export const CompleteMultipartUpload = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindCompleteMultipartUpload(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.CompleteMultipartUpload")(function* (request: CompleteMultipartUploadRequest) {
    return yield* S3.completeMultipartUpload({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindCompleteMultipartUpload = Binding.fn<CompleteMultipartUploadBinding>(
  "AWS.S3.CompleteMultipartUpload",
);

export class CompleteMultipartUploadBinding extends Binding.Service(
  "AWS.S3.CompleteMultipartUpload",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "CompleteMultipartUpload",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `CompleteMultipartUploadBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
