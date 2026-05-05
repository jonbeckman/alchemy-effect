import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete bucket with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("DefaultBucket");
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.storageClass).toEqual("Standard");
    expect(bucket.jurisdiction).toEqual("default");

    const actualBucket = yield* r2.getBucket({
      accountId,
      bucketName: bucket.bucketName,
    });
    expect(actualBucket.name).toEqual(bucket.bucketName);

    yield* stack.destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete bucket", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "Standard",
        });
      }),
    );

    const actualBucket = yield* r2.getBucket({
      accountId,
      bucketName: bucket.bucketName,
    });
    expect(actualBucket.name).toEqual(bucket.bucketName);
    expect(actualBucket.storageClass).toEqual("Standard");

    const updatedBucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "InfrequentAccess",
        });
      }),
    );

    const actualUpdatedBucket = yield* r2.getBucket({
      accountId,
      bucketName: updatedBucket.bucketName,
    });
    expect(actualUpdatedBucket.name).toEqual(updatedBucket.bucketName);
    expect(actualUpdatedBucket.storageClass).toEqual("InfrequentAccess");

    yield* stack.destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(logLevel),
);

// Engine-level adoption: R2 buckets have no ownership signal (Cloudflare
// doesn't expose tags on R2 buckets), so a name match in `read` is treated
// as silent adoption.
test.provider(
  "existing bucket (matching name) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bucketName = `alchemy-test-r2-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy normally so a real R2 bucket exists.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("AdoptableBucket", {
            name: bucketName,
          });
        }),
      );
      expect(initial.bucketName).toEqual(bucketName);

      // Phase 2: wipe local state — the bucket stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableBucket",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which fetches the bucket by name and returns
      // plain attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("AdoptableBucket", {
            name: bucketName,
          });
        }),
      );

      expect(adopted.bucketName).toEqual(bucketName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableBucket",
        });
      }).pipe(Effect.provide(stack.state));

      expect(persisted?.attr).toMatchObject({ bucketName });

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(bucketName, accountId);
    }).pipe(logLevel),
);

// ─────────────────────────────────────────────────────────────────────
// Lifecycle convergence
//
// Reconcile must converge from any starting state — pristine, drifted,
// out-of-band-deleted, or replaced — without leaning on `olds` as a
// source of truth. The tests below pin down each of those starting
// states.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("IdempotentBucket", {
            storageClass: "Standard",
          });
        }),
      );

      // Deploy again with identical props — reconcile must converge
      // without changing the bucket.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("IdempotentBucket", {
            storageClass: "Standard",
          });
        }),
      );

      expect(second.bucketName).toEqual(initial.bucketName);
      expect(second.storageClass).toEqual("Standard");

      const observed = yield* r2.getBucket({
        accountId,
        bucketName: second.bucketName,
      });
      expect(observed.name).toEqual(second.bucketName);
      expect(observed.storageClass ?? "Standard").toEqual("Standard");

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(initial.bucketName, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets storageClass mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("DriftBucket", {
            storageClass: "Standard",
          });
        }),
      );

      // Mutate storage class out-of-band via the raw R2 API.
      yield* r2.patchBucket({
        accountId,
        bucketName: bucket.bucketName,
        storageClass: "InfrequentAccess",
      });
      const drifted = yield* r2.getBucket({
        accountId,
        bucketName: bucket.bucketName,
      });
      expect(drifted.storageClass).toEqual("InfrequentAccess");

      // Re-deploy with the original desired props — reconcile should
      // observe the drifted cloud state and reset storageClass.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("DriftBucket", {
            storageClass: "Standard",
          });
        }),
      );
      expect(redeployed.bucketName).toEqual(bucket.bucketName);
      expect(redeployed.storageClass).toEqual("Standard");

      const observed = yield* r2.getBucket({
        accountId,
        bucketName: bucket.bucketName,
      });
      expect(observed.storageClass ?? "Standard").toEqual("Standard");

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a bucket that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bucketName = `alchemy-test-r2-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("RecreateBucket", {
            name: bucketName,
          });
        }),
      );
      expect(initial.bucketName).toEqual(bucketName);

      // Delete the bucket out-of-band — local state still says it
      // exists, but Cloudflare disagrees.
      yield* r2.deleteBucket({
        accountId,
        bucketName,
      });
      yield* waitForBucketToBeDeleted(bucketName, accountId);

      // Reconcile must observe the missing bucket via getBucket
      // (which now returns NoSuchBucket), fall back to a fresh
      // createBucket, and converge.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("RecreateBucket", {
            name: bucketName,
          });
        }),
      );
      expect(recreated.bucketName).toEqual(bucketName);

      const observed = yield* r2.getBucket({ accountId, bucketName });
      expect(observed.name).toEqual(bucketName);

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(bucketName, accountId);
    }).pipe(logLevel),
);

test.provider(
  "changing name triggers replace; old bucket is deleted",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-r2-rename-a-${suffix}`;
      const nameB = `alchemy-test-r2-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("RenameBucket", {
            name: nameA,
          });
        }),
      );
      expect(a.bucketName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("RenameBucket", {
            name: nameB,
          });
        }),
      );
      expect(b.bucketName).toEqual(nameB);
      expect(b.bucketName).not.toEqual(a.bucketName);

      // The previous physical name must be gone after replace.
      yield* waitForBucketToBeDeleted(nameA, accountId);

      const liveB = yield* r2.getBucket({ accountId, bucketName: nameB });
      expect(liveB.name).toEqual(nameB);

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(nameB, accountId);
    }).pipe(logLevel),
);

test.provider("destroying an already-deleted bucket is a no-op", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("DoubleDestroyBucket");
      }),
    );

    // Delete the bucket out-of-band, then ask the engine to destroy it.
    // `delete` must catch `NoSuchBucket` and complete cleanly.
    yield* r2.deleteBucket({
      accountId,
      bucketName: bucket.bucketName,
    });
    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a foreign bucket under a new logical id",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bucketName = `alchemy-test-r2-adopt-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy under logical id "Original".
      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("Original", {
            name: bucketName,
            storageClass: "Standard",
          });
        }),
      );
      expect(original.bucketName).toEqual(bucketName);

      // Wipe state for the "Original" entry; the bucket stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 2: redeploy under a *different* logical id with the same
      // physical name and `adopt(true)`. R2 has no ownership signal
      // (no tags), so `read` returns plain attrs and the engine adopts.
      // adopt(true) is the explicit user-driven takeover form.
      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.R2Bucket("Different", {
              name: bucketName,
              storageClass: "InfrequentAccess",
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.bucketName).toEqual(bucketName);
      // Reconcile must have applied the new desired storage class on top
      // of the adopted bucket.
      expect(takenOver.storageClass).toEqual("InfrequentAccess");

      const observed = yield* r2.getBucket({ accountId, bucketName });
      expect(observed.storageClass).toEqual("InfrequentAccess");

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(bucketName, accountId);
    }).pipe(logLevel),
);

const waitForBucketToBeDeleted = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  yield* r2
    .getBucket({
      accountId,
      bucketName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists())),
      Effect.retry({
        while: (e): e is BucketStillExists => e instanceof BucketStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NoSuchBucket", () => Effect.void),
    );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}
