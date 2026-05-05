import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
import { Subnet } from "@/AWS/EC2/Subnet";
import { SecurityGroup } from "@/AWS/EC2/SecurityGroup";
import {
  DBCluster,
  DBInstance,
  type DBInstanceProps,
  DBSubnetGroup,
} from "@/AWS/RDS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as RDS from "@distilled.cloud/aws/rds";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// RDS provisioning is slow and expensive — these tests are skipped in
// CI and intended to be unskipped by hand against an isolated test
// account when verifying the reconciler. Each timeout is 20 minutes,
// which is enough for an Aurora Serverless v2 cluster + writer to
// reach `available`, plus headroom for the modify and delete phases.

const RDS_TIMEOUT = 1_200_000;

describe("AWS.RDS.DBInstance", () => {
  // ── Lifecycle convergence ────────────────────────────────────────────
  //
  // Each test runs `destroy → deploy → ... → destroy` and asserts that
  // the reconciler converges every step regardless of starting state.
  // Together they cover: idempotency, drift recovery via
  // `modifyDBInstance`, replace on stable-prop change, double-destroy
  // idempotency, and tag re-write on adopt(true) takeover.

  test.provider.skip(
    "redeploy with same props is a no-op (reconcile is idempotent)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture();
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("Idempotent", {});
          }),
        );

        const second = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("Idempotent", {});
          }),
        );
        expect(second.dbInstanceArn).toEqual(initial.dbInstanceArn);
        expect(second.dbInstanceIdentifier).toEqual(
          initial.dbInstanceIdentifier,
        );

        const described = yield* RDS.describeDBInstances({
          DBInstanceIdentifier: second.dbInstanceIdentifier,
        });
        expect(described.DBInstances?.[0]?.DBInstanceStatus).toEqual(
          "available",
        );

        yield* stack.destroy();
        yield* assertDBInstanceDeleted(initial.dbInstanceIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "reconcile resets backupRetentionPeriod / preferredBackupWindow / parameterGroup mutated out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture();
        const instance = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("Drift", {
              backupRetentionPeriod: 1,
              preferredBackupWindow: "03:00-04:00",
              autoMinorVersionUpgrade: true,
              copyTagsToSnapshot: true,
            });
          }),
        );

        // Mutate every reconciled aspect out-of-band via the raw RDS SDK.
        yield* RDS.modifyDBInstance({
          DBInstanceIdentifier: instance.dbInstanceIdentifier,
          BackupRetentionPeriod: 7,
          PreferredBackupWindow: "10:00-11:00",
          AutoMinorVersionUpgrade: false,
          CopyTagsToSnapshot: false,
          ApplyImmediately: true,
        });
        yield* RDS.removeTagsFromResource({
          ResourceName: instance.dbInstanceArn,
          TagKeys: ["alchemy::id"],
        });
        yield* RDS.addTagsToResource({
          ResourceName: instance.dbInstanceArn,
          Tags: [{ Key: "Owner", Value: "stolen" }],
        });
        yield* waitForDBInstanceAvailable(instance.dbInstanceIdentifier);

        // Re-deploy with the original desired props — reconcile should
        // converge each aspect back, including the alchemy internal tag.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("Drift", {
              backupRetentionPeriod: 1,
              preferredBackupWindow: "03:00-04:00",
              autoMinorVersionUpgrade: true,
              copyTagsToSnapshot: true,
            });
          }),
        );
        expect(redeployed.dbInstanceArn).toEqual(instance.dbInstanceArn);
        expect(redeployed.backupRetentionPeriod).toEqual(1);
        expect(redeployed.preferredBackupWindow).toEqual("03:00-04:00");
        expect(redeployed.tags["alchemy::id"]).toEqual("Drift");

        yield* stack.destroy();
        yield* assertDBInstanceDeleted(instance.dbInstanceIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "changing dbInstanceIdentifier triggers replace, old instance is deleted",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const suffix = Math.random().toString(36).slice(2, 8);
        const idA = `alchemy-test-rds-replace-a-${suffix}`;
        const idB = `alchemy-test-rds-replace-b-${suffix}`;

        const network = networkFixture();
        const a = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("Replaceable", {
              dbInstanceIdentifier: idA,
            });
          }),
        );
        expect(a.dbInstanceIdentifier).toEqual(idA);

        const b = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("Replaceable", {
              dbInstanceIdentifier: idB,
            });
          }),
        );
        expect(b.dbInstanceIdentifier).toEqual(idB);
        expect(b.dbInstanceArn).not.toEqual(a.dbInstanceArn);
        yield* assertDBInstanceDeleted(idA);

        yield* stack.destroy();
        yield* assertDBInstanceDeleted(idB);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "in-place modification of allocatedStorage scales the instance",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture({ aurora: false });
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* standaloneInstance("ScaleStorage", {
              allocatedStorage: 20,
            });
          }),
        );
        expect(initial.allocatedStorage).toEqual(20);

        const scaled = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* standaloneInstance("ScaleStorage", {
              allocatedStorage: 30,
            });
          }),
        );
        expect(scaled.dbInstanceArn).toEqual(initial.dbInstanceArn);
        // RDS may report the new value either immediately or via
        // PendingModifiedValues — wait for it to land.
        yield* waitForAllocatedStorage(scaled.dbInstanceIdentifier, 30);

        yield* stack.destroy();
        yield* assertDBInstanceDeleted(initial.dbInstanceIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "destroying an already-deleted instance is a no-op",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture();
        const instance = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("DoubleDestroy", {});
          }),
        );

        // Delete out-of-band and wait for the deletion to fully converge,
        // then ask the engine to destroy. Provider's `delete` must catch
        // DBInstanceNotFoundFault and complete cleanly.
        yield* RDS.deleteDBInstance({
          DBInstanceIdentifier: instance.dbInstanceIdentifier,
          SkipFinalSnapshot: true,
        });
        yield* assertDBInstanceDeleted(instance.dbInstanceIdentifier);

        yield* stack.destroy();
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "foreign-tagged instance requires adopt(true) to take over and re-tag",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const dbInstanceIdentifier = `alchemy-test-rds-adopt-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const network = networkFixture();

        const original = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* writerInstance("Original", {
              dbInstanceIdentifier,
            });
          }),
        );

        // Wipe state — the instance stays in RDS — and remove our
        // ownership tag so it appears foreign on next read.
        yield* RDS.removeTagsFromResource({
          ResourceName: original.dbInstanceArn,
          TagKeys: ["alchemy::app", "alchemy::stage", "alchemy::id"],
        });

        yield* Effect.gen(function* () {
          const state = yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "Original",
          });
        }).pipe(Effect.provide(stack.state));

        const takenOver = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* network;
              return yield* writerInstance("Different", {
                dbInstanceIdentifier,
              });
            }),
          )
          .pipe(adopt(true));

        expect(takenOver.dbInstanceIdentifier).toEqual(dbInstanceIdentifier);
        expect(takenOver.dbInstanceArn).toEqual(original.dbInstanceArn);
        expect(takenOver.tags["alchemy::id"]).toEqual("Different");

        yield* stack.destroy();
        yield* assertDBInstanceDeleted(takenOver.dbInstanceIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );
});

// ── Test fixtures ─────────────────────────────────────────────────────

/**
 * Build a minimal RDS-ready VPC: 2 subnets across AZs (RDS DB subnet
 * groups require ≥2), a SG that lets the cluster talk to itself, and a
 * `DBSubnetGroup` referencing them. Returns the names/ids the cluster
 * and instance need.
 *
 * For Aurora cluster member tests, also creates the `DBCluster` so the
 * `DBInstance` only needs `dbClusterIdentifier`.
 */
const networkFixture = (
  options: { aurora?: boolean } = { aurora: true },
) =>
  Effect.gen(function* () {
    const vpc = yield* Vpc("RdsTestVpc", {
      cidrBlock: "10.42.0.0/16",
      enableDnsSupport: true,
      enableDnsHostnames: true,
    });
    const subnetA = yield* Subnet("RdsTestSubnetA", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.42.1.0/24",
      availabilityZone: "us-east-1a",
    });
    const subnetB = yield* Subnet("RdsTestSubnetB", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.42.2.0/24",
      availabilityZone: "us-east-1b",
    });
    const sg = yield* SecurityGroup("RdsTestSG", {
      vpcId: vpc.vpcId,
      groupName: "alchemy-test-rds-sg",
      description: "Test SG for RDS hardening",
    });
    const subnetGroup = yield* DBSubnetGroup("RdsTestSubnetGroup", {
      subnetIds: [subnetA.subnetId, subnetB.subnetId],
    });
    if (!options.aurora) {
      return {
        dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
        vpcSecurityGroupIds: [sg.groupId],
        dbClusterIdentifier: undefined as string | undefined,
      };
    }
    const cluster = yield* DBCluster("RdsTestCluster", {
      engine: "aurora-postgresql",
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: [sg.groupId],
      manageMasterUserPassword: true,
      masterUsername: "alchemy",
      serverlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 1,
      },
      engineMode: "provisioned",
    });
    return {
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: [sg.groupId],
      dbClusterIdentifier: cluster.dbClusterIdentifier,
    };
  });

const writerInstance = (
  id: string,
  overrides: Partial<DBInstanceProps>,
) =>
  Effect.gen(function* () {
    // Aurora cluster member — cheapest setup, ~5min create.
    return yield* DBInstance(id, {
      dbInstanceClass: "db.serverless",
      engine: "aurora-postgresql",
      promotionTier: 0,
      autoMinorVersionUpgrade: true,
      copyTagsToSnapshot: true,
      ...overrides,
    });
  });

const standaloneInstance = (
  id: string,
  overrides: Partial<DBInstanceProps>,
) =>
  Effect.gen(function* () {
    // Standalone (non-Aurora) for storage-scaling tests; cluster
    // members ignore `allocatedStorage`.
    return yield* DBInstance(id, {
      dbInstanceClass: "db.t3.micro",
      engine: "postgres",
      allocatedStorage: 20,
      ...overrides,
    });
  });

// ── Polling helpers ──────────────────────────────────────────────────

class DBInstanceNotAvailable extends Data.TaggedError(
  "DBInstanceNotAvailable",
)<{ status: string | undefined }> {}

class DBInstanceStorageStale extends Data.TaggedError(
  "DBInstanceStorageStale",
)<{ observed: number | undefined; expected: number }> {}

class DBInstanceStillExists extends Data.TaggedError("DBInstanceStillExists") {}

const stableStateSchedule = Schedule.fixed("10 seconds").pipe(
  Schedule.both(Schedule.recurs(120)),
);

const waitForDBInstanceAvailable = Effect.fn(function* (identifier: string) {
  yield* RDS.describeDBInstances({ DBInstanceIdentifier: identifier }).pipe(
    Effect.flatMap((r) => {
      const status = r.DBInstances?.[0]?.DBInstanceStatus;
      return status === "available"
        ? Effect.void
        : Effect.fail(new DBInstanceNotAvailable({ status }));
    }),
    Effect.retry({
      while: (e) => e._tag === "DBInstanceNotAvailable",
      schedule: stableStateSchedule,
    }),
  );
});

const waitForAllocatedStorage = Effect.fn(function* (
  identifier: string,
  expected: number,
) {
  yield* RDS.describeDBInstances({ DBInstanceIdentifier: identifier }).pipe(
    Effect.flatMap((r) => {
      const observed = r.DBInstances?.[0]?.AllocatedStorage;
      return observed === expected
        ? Effect.void
        : Effect.fail(new DBInstanceStorageStale({ observed, expected }));
    }),
    Effect.retry({
      while: (e) => e._tag === "DBInstanceStorageStale",
      schedule: stableStateSchedule,
    }),
  );
});

const assertDBInstanceDeleted = Effect.fn(function* (identifier: string) {
  yield* RDS.describeDBInstances({ DBInstanceIdentifier: identifier }).pipe(
    Effect.flatMap(() => Effect.fail(new DBInstanceStillExists())),
    Effect.retry({
      while: (e) => e._tag === "DBInstanceStillExists",
      schedule: stableStateSchedule,
    }),
    Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
  );
});
