import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListObjectsV2Request extends Omit<
  S3.ListObjectsV2Request,
  "Bucket"
> {}

export const ListObjectsV2 = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindListObjectsV2(bucket);
  const BucketName = yield* bucket.bucketName();
  Effect.fn("AWS.S3.ListObjectsV2")(function* (request?: ListObjectsV2Request) {
    return yield* S3.listObjectsV2({
      ...request,
      Bucket: yield* BucketName,
    });
  });
});

export const bindListObjectsV2 = Binding.fn<ListObjectsV2Binding>(
  "AWS.S3.ListObjectsV2",
);

export class ListObjectsV2Binding extends Binding.Service(
  "AWS.S3.ListObjectsV2",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "ListObjectsV2",
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [Output.interpolate`${bucket.bucketArn()}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `ListObjectsV2Binding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
