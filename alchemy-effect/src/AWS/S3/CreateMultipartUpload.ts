import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CreateMultipartUploadRequest extends Omit<
  S3.CreateMultipartUploadRequest,
  "Bucket"
> {}

export const CreateMultipartUpload = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindCreateMultipartUpload(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.CreateMultipartUpload")(function* (request: CreateMultipartUploadRequest) {
    return yield* S3.createMultipartUpload({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindCreateMultipartUpload = Binding.fn<CreateMultipartUploadBinding>(
  "AWS.S3.CreateMultipartUpload",
);

export class CreateMultipartUploadBinding extends Binding.Service(
  "AWS.S3.CreateMultipartUpload",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "CreateMultipartUpload",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `CreateMultipartUploadBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
