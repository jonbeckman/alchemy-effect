import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const TAG_FQN = "alchemy::id";
const TAG_STAGE = "alchemy::stage";

const clusterTagMap = (cluster: ecs.Cluster | undefined) =>
  Object.fromEntries(
    (cluster?.tags ?? [])
      .filter(
        (t): t is { key: string; value: string } =>
          typeof t.key === "string" && typeof t.value === "string",
      )
      .map((t) => [t.key, t.value]),
  );

const describeOne = Effect.fn(function* (clusterArn: string) {
  const r = yield* ecs.describeClusters({
    clusters: [clusterArn],
    include: ["SETTINGS", "TAGS", "CONFIGURATIONS"],
  });
  return r.clusters?.[0];
});

class ClusterStillExists extends Data.TaggedError("ClusterStillExists") {}
class ClusterSettingsNotMatched extends Data.TaggedError(
  "ClusterSettingsNotMatched",
) {}

const assertClusterDeleted = Effect.fn(function* (clusterArn: string) {
  yield* Effect.gen(function* () {
    const cluster = yield* describeOne(clusterArn);
    if (
      cluster &&
      cluster.status !== "INACTIVE" &&
      cluster.status !== "DEPROVISIONING"
    ) {
      return yield* Effect.fail(new ClusterStillExists());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ClusterStillExists",
      schedule: Schedule.exponential(200).pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
});

const waitForContainerInsights = Effect.fn(function* (
  clusterArn: string,
  expected: string,
) {
  yield* Effect.gen(function* () {
    const cluster = yield* describeOne(clusterArn);
    const setting = cluster?.settings?.find((s) => s.name === "containerInsights");
    if (setting?.value !== expected) {
      return yield* Effect.fail(new ClusterSettingsNotMatched());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ClusterSettingsNotMatched",
      schedule: Schedule.fixed("1 second").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
});

test.provider("create and delete cluster with default props", (stack) =>
  Effect.gen(function* () {
    const cluster = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cluster("DefaultCluster", {});
      }),
    );

    expect(cluster.clusterArn).toMatch(/^arn:aws:ecs:[^:]+:\d+:cluster\//);
    expect(cluster.clusterName).toBeDefined();
    const described = yield* describeOne(cluster.clusterArn);
    expect(described?.status).toEqual("ACTIVE");

    yield* stack.destroy();
    yield* assertClusterDeleted(cluster.clusterArn);
  }),
);

test.provider("redeploy with same props is a no-op (reconcile is idempotent)", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cluster("IdempotentCluster", {
          settings: [{ name: "containerInsights", value: "enabled" }],
        });
      }),
    );

    const second = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cluster("IdempotentCluster", {
          settings: [{ name: "containerInsights", value: "enabled" }],
        });
      }),
    );
    expect(second.clusterArn).toEqual(initial.clusterArn);
    expect(second.clusterName).toEqual(initial.clusterName);

    yield* waitForContainerInsights(second.clusterArn, "enabled");

    yield* stack.destroy();
    yield* assertClusterDeleted(initial.clusterArn);
  }),
);

test.provider(
  "reconcile resets settings mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("DriftCluster", {
            settings: [{ name: "containerInsights", value: "enabled" }],
          });
        }),
      );
      yield* waitForContainerInsights(cluster.clusterArn, "enabled");

      // Mutate settings out-of-band via the raw SDK.
      yield* ecs.updateClusterSettings({
        cluster: cluster.clusterArn,
        settings: [{ name: "containerInsights", value: "disabled" }],
      });
      yield* waitForContainerInsights(cluster.clusterArn, "disabled");

      // Re-deploy with the same desired props — reconcile must reset the
      // drifted setting back to the desired value.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("DriftCluster", {
            settings: [{ name: "containerInsights", value: "enabled" }],
          });
        }),
      );
      expect(redeployed.clusterArn).toEqual(cluster.clusterArn);
      yield* waitForContainerInsights(cluster.clusterArn, "enabled");

      yield* stack.destroy();
      yield* assertClusterDeleted(cluster.clusterArn);
    }),
);

test.provider(
  "reconcile re-creates a cluster that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = `alchemy-test-ecs-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("RecreateCluster", { clusterName });
        }),
      );

      // Delete the cluster out of band.
      yield* ecs.deleteCluster({ cluster: initial.clusterArn });
      yield* assertClusterDeleted(initial.clusterArn);

      // Re-deploy must converge by re-creating. ECS keeps INACTIVE clusters
      // around for ~1h, so the reconciler has to skip them rather than try
      // to update a tombstone.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("RecreateCluster", { clusterName });
        }),
      );
      expect(recreated.clusterName).toEqual(clusterName);
      const described = yield* describeOne(recreated.clusterArn);
      expect(described?.status).toEqual("ACTIVE");

      yield* stack.destroy();
      yield* assertClusterDeleted(recreated.clusterArn);
    }),
  { timeout: 240_000 },
);

test.provider(
  "changing clusterName triggers replace, old cluster is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-ecs-replace-a-${suffix}`;
      const nameB = `alchemy-test-ecs-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("RenameCluster", { clusterName: nameA });
        }),
      );
      expect(a.clusterName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("RenameCluster", { clusterName: nameB });
        }),
      );
      expect(b.clusterName).toEqual(nameB);
      expect(b.clusterArn).not.toEqual(a.clusterArn);

      yield* assertClusterDeleted(a.clusterArn);

      yield* stack.destroy();
      yield* assertClusterDeleted(b.clusterArn);
    }),
);

test.provider(
  "destroying an already-deleted cluster is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("DoubleDestroyCluster", {});
        }),
      );

      // Delete out of band, then ask the engine to destroy. Provider's
      // `delete` must catch `ClusterNotFoundException` and complete cleanly.
      yield* ecs.deleteCluster({ cluster: cluster.clusterArn });
      yield* assertClusterDeleted(cluster.clusterArn);

      yield* stack.destroy();
    }),
);

test.provider(
  "adopt(true) re-tags a foreign cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = `alchemy-test-ecs-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Create a cluster out-of-band that has NO alchemy tags — this is a
      // "foreign" cluster.
      const created = yield* ecs.createCluster({
        clusterName,
        tags: [{ key: "owner", value: "external" }],
      });
      const foreignArn = created.cluster!.clusterArn!;

      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cluster("Foreign", { clusterName });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.clusterName).toEqual(clusterName);
      expect(takenOver.clusterArn).toEqual(foreignArn);

      // After adopt(true), reconcile should have re-tagged the cluster
      // with the internal alchemy tags.
      const observed = yield* describeOne(takenOver.clusterArn);
      const tagMap = clusterTagMap(observed);
      expect(tagMap[TAG_FQN]).toBeDefined();
      expect(tagMap[TAG_STAGE]).toBeDefined();
      // The user-defined tag should still be present.
      expect(tagMap.owner).toEqual("external");

      yield* stack.destroy();
      yield* assertClusterDeleted(takenOver.clusterArn);
    }),
);

test.provider(
  "foreign-tagged cluster requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = `alchemy-test-ecs-foreign-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // First, deploy a cluster with this stack so internal tags get set.
      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("Original", { clusterName });
        }),
      );

      // Forget the resource from state so the next deploy goes through the
      // read → Unowned path.
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
            return yield* Cluster("Different", { clusterName });
          }),
        )
        .pipe(adopt(true));

      expect(adopted.clusterArn).toEqual(original.clusterArn);

      yield* stack.destroy();
      yield* assertClusterDeleted(original.clusterArn);
    }),
);
