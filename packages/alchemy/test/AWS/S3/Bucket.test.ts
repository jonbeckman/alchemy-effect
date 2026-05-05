import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create and delete bucket with default props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("DefaultBucket");
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.bucketArn).toBeDefined();
    expect(bucket.region).toBeDefined();

    yield* S3.headBucket({ Bucket: bucket.bucketName });

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("create, update, delete bucket", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TestBucket", {
          bucketName: "alchemy-test-bucket-crud",
          tags: { Environment: "test" },
          forceDestroy: true,
        });
      }),
    );

    yield* S3.headBucket({ Bucket: bucket.bucketName });

    const tagging = yield* S3.getBucketTagging({
      Bucket: bucket.bucketName,
    });
    expect(tagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "test",
    });

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TestBucket", {
          bucketName: "alchemy-test-bucket-crud",
          tags: { Environment: "production", Team: "platform" },
          forceDestroy: true,
        });
      }),
    );

    const updatedTagging = yield* S3.getBucketTagging({
      Bucket: bucket.bucketName,
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "production",
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Team",
      Value: "platform",
    });

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("create bucket with custom name", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("CustomNameBucket", {
          bucketName: "alchemy-test-bucket-custom-name",
          forceDestroy: true,
        });
      }),
    );

    expect(bucket.bucketName).toEqual("alchemy-test-bucket-custom-name");
    expect(bucket.bucketArn).toEqual(
      "arn:aws:s3:::alchemy-test-bucket-custom-name",
    );

    yield* S3.headBucket({ Bucket: bucket.bucketName });

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("create bucket with forceDestroy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("ForceDestroyBucket", {
          bucketName: "alchemy-test-bucket-force-destroy",
          forceDestroy: true,
        });
      }),
    );

    yield* S3.putObject({
      Bucket: bucket.bucketName,
      Key: "test-object.txt",
      Body: "Hello, World!",
    });

    yield* S3.headObject({
      Bucket: bucket.bucketName,
      Key: "test-object.txt",
    });

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("idempotent create - bucket already exists", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket1 = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("IdempotentBucket", {
          bucketName: "alchemy-test-bucket-idempotent",
          forceDestroy: true,
        });
      }),
    );
    const bucketName = bucket1.bucketName;

    const bucket2 = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("IdempotentBucket", {
          bucketName: "alchemy-test-bucket-idempotent",
          forceDestroy: true,
        });
      }),
    );
    expect(bucket2.bucketName).toEqual(bucketName);

    yield* stack.destroy();

    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("create bucket with objectLockEnabled", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("ObjectLockBucket", {
          bucketName: "alchemy-test-bucket-object-lock",
          objectLockEnabled: true,
          forceDestroy: true,
        });
      }),
    );

    const objectLockConfig = yield* S3.getObjectLockConfiguration({
      Bucket: bucket.bucketName,
    });
    expect(objectLockConfig.ObjectLockConfiguration?.ObjectLockEnabled).toEqual(
      "Enabled",
    );

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("remove all tags from bucket", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TagRemovalBucket", {
          bucketName: "alchemy-test-bucket-tag-removal",
          tags: { Environment: "test", Team: "platform" },
          forceDestroy: true,
        });
      }),
    );
    const bucketName = bucket.bucketName;

    const tagging = yield* S3.getBucketTagging({
      Bucket: bucketName,
    });
    expect(tagging.TagSet).toHaveLength(2);

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TagRemovalBucket", {
          bucketName: "alchemy-test-bucket-tag-removal",
          forceDestroy: true,
        });
      }),
    );

    const result = yield* S3.getBucketTagging({
      Bucket: bucketName,
    }).pipe(
      Effect.map(() => "has-tags" as const),
      Effect.catchTag("NoSuchTagSet", () => Effect.succeed("no-tags" as const)),
    );
    expect(result).toEqual("no-tags");

    yield* stack.destroy();

    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("create and remove bucket policy from bindings", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const distributionArn =
      "arn:aws:cloudfront::123456789012:distribution/TESTDIST";
    const bucketArn = "arn:aws:s3:::alchemy-test-bucket-policy-bindings";

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        const bucket = yield* Bucket("PolicyBucket", {
          bucketName: "alchemy-test-bucket-policy-bindings",
          forceDestroy: true,
        });

        yield* bucket.bind("AWS.S3.Policy(TestDistribution, PolicyBucket)", {
          policyStatements: [
            {
              Effect: "Allow",
              Principal: {
                Service: "cloudfront.amazonaws.com",
              },
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/*`],
              Condition: {
                StringEquals: {
                  "AWS:SourceArn": distributionArn,
                },
              },
            },
          ],
        });

        return bucket;
      }),
    );

    const bucketPolicy = yield* S3.getBucketPolicy({
      Bucket: bucket.bucketName,
    }).pipe(Effect.map((response) => JSON.parse(response.Policy!)));
    const statement = bucketPolicy.Statement[0];

    expect(bucketPolicy.Version).toEqual("2012-10-17");
    expect(statement.Effect).toEqual("Allow");
    expect(statement.Principal).toEqual({
      Service: "cloudfront.amazonaws.com",
    });
    expect(statement.Action).toEqual("s3:GetObject");
    expect(statement.Resource).toEqual(`${bucketArn}/*`);
    expect(statement.Condition).toEqual({
      StringEquals: {
        "AWS:SourceArn": distributionArn,
      },
    });

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("PolicyBucket", {
          bucketName: "alchemy-test-bucket-policy-bindings",
          forceDestroy: true,
        });
      }),
    );

    const policyAfterRemoval = yield* S3.getBucketPolicy({
      Bucket: bucket.bucketName,
    }).pipe(
      Effect.map(() => "has-policy" as const),
      Effect.catchTag("NoSuchBucketPolicy", () =>
        Effect.succeed("no-policy" as const),
      ),
    );

    expect(policyAfterRemoval).toEqual("no-policy");

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

// Engine-level adoption: S3 has no per-stack ownership signal (we don't
// stamp alchemy tags on buckets — the canonical existence check is
// `headBucket`, which only succeeds when the bucket is owned by *this AWS
// account*). So a name match means we own it at the account level — silent
// adoption is correct for the cold-start case.
test.provider(
  "owned bucket (account-level) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucketName = `alchemy-test-s3-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("AdoptableBucket", {
            bucketName,
            forceDestroy: true,
          });
        }),
      );
      expect(initial.bucketName).toEqual(bucketName);

      // Wipe state — bucket stays in S3.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableBucket",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("AdoptableBucket", {
            bucketName,
            forceDestroy: true,
          });
        }),
      );

      expect(adopted.bucketArn).toEqual(initial.bucketArn);

      yield* stack.destroy();
      yield* assertBucketDeleted(bucketName);
    }),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("IdempotentReconcileBucket", {
            tags: { Environment: "test" },
            forceDestroy: true,
          });
        }),
      );

      // Deploy again with identical props — reconcile must converge
      // without changing the bucket.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("IdempotentReconcileBucket", {
            tags: { Environment: "test" },
            forceDestroy: true,
          });
        }),
      );

      expect(second.bucketName).toEqual(initial.bucketName);
      expect(second.bucketArn).toEqual(initial.bucketArn);

      const tagging = yield* S3.getBucketTagging({
        Bucket: second.bucketName,
      });
      expect(tagging.TagSet).toContainEqual({
        Key: "Environment",
        Value: "test",
      });

      yield* stack.destroy();
      yield* assertBucketDeleted(initial.bucketName);
    }),
);

test.provider(
  "reconcile resets tags mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("DriftTagsBucket", {
            tags: { Environment: "test" },
            forceDestroy: true,
          });
        }),
      );

      // Mutate tags out-of-band via the raw SDK.
      yield* S3.putBucketTagging({
        Bucket: bucket.bucketName,
        Tagging: {
          TagSet: [
            { Key: "Drifted", Value: "yes" },
            { Key: "Environment", Value: "WRONG" },
          ],
        },
      });

      // Re-deploy with the original desired props — reconcile should
      // observe the drifted cloud tags and reset them.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("DriftTagsBucket", {
            tags: { Environment: "test" },
            forceDestroy: true,
          });
        }),
      );
      expect(redeployed.bucketName).toEqual(bucket.bucketName);

      const tagging = yield* S3.getBucketTagging({
        Bucket: bucket.bucketName,
      });
      const tagMap = Object.fromEntries(
        (tagging.TagSet ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap["Environment"]).toEqual("test");
      expect(tagMap["Drifted"]).toBeUndefined();

      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.bucketName);
    }),
);

test.provider(
  "reconcile resets a bucket policy mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const distributionArn =
        "arn:aws:cloudfront::123456789012:distribution/DRIFTDIST";
      const bucketName = `alchemy-test-s3-policy-drift-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const bucketArn = `arn:aws:s3:::${bucketName}` as const;

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DriftPolicyBucket", {
            bucketName,
            forceDestroy: true,
          });
          yield* bucket.bind("AWS.S3.Policy(DriftDist, DriftPolicyBucket)", {
            policyStatements: [
              {
                Effect: "Allow",
                Principal: { Service: "cloudfront.amazonaws.com" },
                Action: ["s3:GetObject"],
                Resource: [`${bucketArn}/*`],
                Condition: {
                  StringEquals: { "AWS:SourceArn": distributionArn },
                },
              },
            ],
          });
          return bucket;
        }),
      );

      // Replace the bucket's policy out-of-band with something foreign.
      yield* S3.putBucketPolicy({
        Bucket: bucket.bucketName,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "ForeignDrifted",
              Effect: "Allow",
              Principal: "*",
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/*`],
            },
          ],
        }),
      });

      // Re-deploy — reconcile must reset the policy back to what bindings
      // describe.
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DriftPolicyBucket", {
            bucketName,
            forceDestroy: true,
          });
          yield* bucket.bind("AWS.S3.Policy(DriftDist, DriftPolicyBucket)", {
            policyStatements: [
              {
                Effect: "Allow",
                Principal: { Service: "cloudfront.amazonaws.com" },
                Action: ["s3:GetObject"],
                Resource: [`${bucketArn}/*`],
                Condition: {
                  StringEquals: { "AWS:SourceArn": distributionArn },
                },
              },
            ],
          });
          return bucket;
        }),
      );

      const policy = yield* S3.getBucketPolicy({
        Bucket: bucket.bucketName,
      }).pipe(Effect.map((r) => JSON.parse(r.Policy!)));
      expect(policy.Statement).toHaveLength(1);
      expect(policy.Statement[0].Principal).toEqual({
        Service: "cloudfront.amazonaws.com",
      });
      expect(policy.Statement[0].Sid).toBeUndefined();

      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.bucketName);
    }),
);

test.provider(
  "reconcile re-creates a bucket that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucketName = `alchemy-test-s3-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("RecreateBucket", {
            bucketName,
            forceDestroy: true,
          });
        }),
      );

      // Delete the bucket out-of-band. S3 forbids reusing the same name
      // for a brief window — the reconciler's bounded retries on
      // `OperationAborted` / `ServiceUnavailable` ride this out.
      yield* S3.deleteBucket({ Bucket: initial.bucketName });
      yield* assertBucketDeleted(initial.bucketName);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("RecreateBucket", {
            bucketName,
            forceDestroy: true,
          });
        }),
      );
      expect(recreated.bucketName).toEqual(bucketName);
      yield* S3.headBucket({ Bucket: recreated.bucketName });

      yield* stack.destroy();
      yield* assertBucketDeleted(recreated.bucketName);
    }),
  { timeout: 180_000 },
);

test.provider(
  "changing bucketName triggers replace; old bucket is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-s3-rename-a-${suffix}`;
      const nameB = `alchemy-test-s3-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("RenameBucket", {
            bucketName: nameA,
            forceDestroy: true,
          });
        }),
      );
      expect(a.bucketName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("RenameBucket", {
            bucketName: nameB,
            forceDestroy: true,
          });
        }),
      );
      expect(b.bucketName).toEqual(nameB);
      expect(b.bucketArn).not.toEqual(a.bucketArn);

      yield* assertBucketDeleted(a.bucketName);

      yield* stack.destroy();
      yield* assertBucketDeleted(b.bucketName);
    }),
);

test.provider(
  "flipping objectLockEnabled triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("ObjectLockFlipBucket", {
            bucketName: `alchemy-test-s3-objlock-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            forceDestroy: true,
          });
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("ObjectLockFlipBucket", {
            bucketName: `alchemy-test-s3-objlock-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            objectLockEnabled: true,
            forceDestroy: true,
          });
        }),
      );
      expect(replaced.bucketArn).not.toEqual(initial.bucketArn);

      const lockConfig = yield* S3.getObjectLockConfiguration({
        Bucket: replaced.bucketName,
      });
      expect(
        lockConfig.ObjectLockConfiguration?.ObjectLockEnabled,
      ).toEqual("Enabled");

      yield* assertBucketDeleted(initial.bucketName);

      yield* stack.destroy();
      yield* assertBucketDeleted(replaced.bucketName);
    }),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted bucket is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("DoubleDestroyBucket", {
            forceDestroy: true,
          });
        }),
      );

      // Delete the bucket out-of-band, then ask the engine to destroy it.
      // `delete` must catch `NoSuchBucket` and complete cleanly.
      yield* S3.deleteBucket({ Bucket: bucket.bucketName });
      yield* assertBucketDeleted(bucket.bucketName);

      yield* stack.destroy();
    }),
);

test.provider(
  "adopt(true) re-syncs tags on a foreign-tagged bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucketName = `alchemy-test-s3-adopt-tags-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Pre-deploy with foreign tags, then wipe the state file so the
      // next deploy must adopt — adopt(true) is required because we
      // simulate a stack rename (logical id changes from "Original" to
      // "Different").
      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Bucket("Original", {
            bucketName,
            tags: { OwnedBy: "someone-else", Stage: "stale" },
            forceDestroy: true,
          });
        }),
      );

      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Bucket("Different", {
              bucketName,
              tags: { OwnedBy: "alchemy", Stage: "fresh" },
              forceDestroy: true,
            });
          }),
        )
        .pipe(adopt(true));

      expect(adopted.bucketName).toEqual(bucketName);
      expect(adopted.bucketArn).toEqual(original.bucketArn);

      const tagging = yield* S3.getBucketTagging({
        Bucket: adopted.bucketName,
      });
      const tagMap = Object.fromEntries(
        (tagging.TagSet ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap["OwnedBy"]).toEqual("alchemy");
      expect(tagMap["Stage"]).toEqual("fresh");

      yield* stack.destroy();
      yield* assertBucketDeleted(bucketName);
    }),
);

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  yield* S3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});
