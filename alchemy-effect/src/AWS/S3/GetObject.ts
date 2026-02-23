import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

export const GetObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindGetObject(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.GetObject")(function* (request: GetObjectRequest) {
    return yield* S3.getObject({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindGetObject = Binding.fn<GetObjectBinding>(
  "AWS.S3.GetObject",
);

export class GetObjectBinding extends Binding.Service(
  "AWS.S3.GetObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "GetObject",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `GetObjectBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
