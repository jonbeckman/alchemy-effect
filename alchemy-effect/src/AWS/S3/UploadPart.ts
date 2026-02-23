import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface UploadPartRequest extends Omit<
  S3.UploadPartRequest,
  "Bucket"
> {}

export const UploadPart = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindUploadPart(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.UploadPart")(function* (request: UploadPartRequest) {
    return yield* S3.uploadPart({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindUploadPart = Binding.fn<UploadPartBinding>(
  "AWS.S3.UploadPart",
);

export class UploadPartBinding extends Binding.Service(
  "AWS.S3.UploadPart",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "UploadPart",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `UploadPartBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
