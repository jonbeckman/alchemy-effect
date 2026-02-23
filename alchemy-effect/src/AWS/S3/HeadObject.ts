import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface HeadObjectRequest extends Omit<
  S3.HeadObjectRequest,
  "Bucket"
> {}

export const HeadObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindHeadObject(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.HeadObject")(function* (request: HeadObjectRequest) {
    return yield* S3.headObject({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindHeadObject = Binding.fn<HeadObjectBinding>(
  "AWS.S3.HeadObject",
);

export class HeadObjectBinding extends Binding.Service(
  "AWS.S3.HeadObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "HeadObject",
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `HeadObjectBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
