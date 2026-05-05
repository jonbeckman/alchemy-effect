import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Cluster, Service } from "@/AWS/ECS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const TAG_FQN = "alchemy::id";
const TAG_STAGE = "alchemy::stage";

const tagMapOf = (service: ecs.Service | undefined) =>
  Object.fromEntries(
    (service?.tags ?? [])
      .filter(
        (t): t is { key: string; value: string } =>
          typeof t.key === "string" && typeof t.value === "string",
      )
      .map((t) => [t.key, t.value]),
  );

const describeOne = Effect.fn(function* (
  clusterArn: string,
  serviceName: string,
) {
  const r = yield* ecs.describeServices({
    cluster: clusterArn,
    services: [serviceName],
    include: ["TAGS"],
  });
  return r.services?.[0];
});

class ServiceStillActive extends Data.TaggedError("ServiceStillActive") {}
class ServiceDesiredCountMismatch extends Data.TaggedError(
  "ServiceDesiredCountMismatch",
) {}
class ServiceTaskDefMismatch extends Data.TaggedError(
  "ServiceTaskDefMismatch",
) {}

const assertServiceDeleted = Effect.fn(function* (
  clusterArn: string,
  serviceName: string,
) {
  yield* Effect.gen(function* () {
    const service = yield* describeOne(clusterArn, serviceName).pipe(
      Effect.catchTag("ClusterNotFoundException", () => Effect.succeed(undefined)),
    );
    if (service && service.status !== "INACTIVE") {
      return yield* Effect.fail(new ServiceStillActive());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ServiceStillActive",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
});

const waitForDesiredCount = Effect.fn(function* (
  clusterArn: string,
  serviceName: string,
  expected: number,
) {
  yield* Effect.gen(function* () {
    const service = yield* describeOne(clusterArn, serviceName);
    if (service?.desiredCount !== expected) {
      return yield* Effect.fail(new ServiceDesiredCountMismatch());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ServiceDesiredCountMismatch",
      schedule: Schedule.fixed("1 second").pipe(
        Schedule.both(Schedule.recurs(30)),
      ),
    }),
  );
});

const waitForTaskDef = Effect.fn(function* (
  clusterArn: string,
  serviceName: string,
  expected: string,
) {
  yield* Effect.gen(function* () {
    const service = yield* describeOne(clusterArn, serviceName);
    if (service?.taskDefinition !== expected) {
      return yield* Effect.fail(new ServiceTaskDefMismatch());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ServiceTaskDefMismatch",
      schedule: Schedule.fixed("1 second").pipe(
        Schedule.both(Schedule.recurs(30)),
      ),
    }),
  );
});

// Register a tiny inline task definition. We avoid IAM roles by skipping
// the awslogs driver and using a public image. Fargate accepts this so
// long as desiredCount stays at 0 — we never actually run a task in
// these lifecycle tests.
const registerTaskDef = Effect.fn(function* (suffix: string) {
  const family = `alchemy-test-svc-${suffix}`;
  const r = yield* ecs.registerTaskDefinition({
    family,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "256",
    memory: "512",
    containerDefinitions: [
      {
        essential: true,
        name: "app",
        image: "public.ecr.aws/nginx/nginx:alpine",
        portMappings: [
          {
            containerPort: 80,
            hostPort: 80,
            protocol: "tcp",
          },
        ],
      },
    ],
  });
  return r.taskDefinition!.taskDefinitionArn!;
});

const deregisterTaskDef = Effect.fn(function* (arn: string) {
  yield* ecs.deregisterTaskDefinition({ taskDefinition: arn });
});

// Use the account's default VPC + subnets for awsvpc networking. This
// keeps the tests self-contained without provisioning a VPC.
const defaultNetworking = Effect.fn(function* () {
  const vpcs = yield* ec2.describeVpcs({
    Filters: [{ Name: "is-default", Values: ["true"] }],
  });
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) {
    return yield* Effect.die(
      new Error(
        "no default VPC in this account; set TEST_VPC_ID + TEST_SUBNETS",
      ),
    );
  }
  const subnets = yield* ec2.describeSubnets({
    Filters: [{ Name: "vpc-id", Values: [vpcId] }],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is string => typeof id === "string");
  if (subnetIds.length < 1) {
    return yield* Effect.die(
      new Error(`no subnets in default VPC ${vpcId}`),
    );
  }
  return { vpcId, subnets: subnetIds.slice(0, 2) };
});

const TIMEOUT = 600_000;

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const network = yield* defaultNetworking();
      const taskDefArn = yield* registerTaskDef(suffix);

      try {
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("IdempotentSvcCluster", {});
            return yield* Service("IdempotentSvc", {
              cluster,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );

        const second = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("IdempotentSvcCluster", {});
            return yield* Service("IdempotentSvc", {
              cluster,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );
        expect(second.serviceArn).toEqual(initial.serviceArn);
        expect(second.serviceName).toEqual(initial.serviceName);
        expect(second.taskDefinitionArn).toEqual(taskDefArn);

        yield* waitForDesiredCount(initial.clusterArn, initial.serviceName, 0);

        yield* stack.destroy();
        yield* assertServiceDeleted(initial.clusterArn, initial.serviceName);
      } finally {
        yield* deregisterTaskDef(taskDefArn).pipe(Effect.ignore);
      }
    }),
  { timeout: TIMEOUT },
);

test.provider(
  "reconcile resets desiredCount mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const network = yield* defaultNetworking();
      const taskDefArn = yield* registerTaskDef(suffix);

      try {
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("DriftSvcCluster", {});
            return yield* Service("DriftSvc", {
              cluster,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );

        // Mutate desiredCount out-of-band via the raw SDK.
        yield* ecs.updateService({
          cluster: initial.clusterArn,
          service: initial.serviceName,
          desiredCount: 2,
        });
        yield* waitForDesiredCount(initial.clusterArn, initial.serviceName, 2);

        // Re-deploy with the same desired props — reconcile must reset
        // desiredCount back to the desired value.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("DriftSvcCluster", {});
            return yield* Service("DriftSvc", {
              cluster,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );
        expect(redeployed.serviceArn).toEqual(initial.serviceArn);
        yield* waitForDesiredCount(initial.clusterArn, initial.serviceName, 0);

        yield* stack.destroy();
        yield* assertServiceDeleted(initial.clusterArn, initial.serviceName);
      } finally {
        yield* deregisterTaskDef(taskDefArn).pipe(Effect.ignore);
      }
    }),
  { timeout: TIMEOUT },
);

test.provider(
  "rolling task-definition update converges to the new revision",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const network = yield* defaultNetworking();
      const taskDefArnA = yield* registerTaskDef(suffix);
      const taskDefArnB = yield* registerTaskDef(suffix);
      // The two registrations share a family, so revision-2 should be
      // strictly greater than revision-1.
      expect(taskDefArnB).not.toEqual(taskDefArnA);

      try {
        const v1 = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("RollingSvcCluster", {});
            return yield* Service("RollingSvc", {
              cluster,
              task: {
                taskDefinitionArn: taskDefArnA,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );
        expect(v1.taskDefinitionArn).toEqual(taskDefArnA);

        const v2 = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("RollingSvcCluster", {});
            return yield* Service("RollingSvc", {
              cluster,
              task: {
                taskDefinitionArn: taskDefArnB,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );
        expect(v2.serviceArn).toEqual(v1.serviceArn);
        expect(v2.taskDefinitionArn).toEqual(taskDefArnB);
        yield* waitForTaskDef(v1.clusterArn, v1.serviceName, taskDefArnB);

        yield* stack.destroy();
        yield* assertServiceDeleted(v1.clusterArn, v1.serviceName);
      } finally {
        yield* deregisterTaskDef(taskDefArnA).pipe(Effect.ignore);
        yield* deregisterTaskDef(taskDefArnB).pipe(Effect.ignore);
      }
    }),
  { timeout: TIMEOUT },
);

test.provider(
  "changing serviceName triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-svc-replace-a-${suffix}`;
      const nameB = `alchemy-test-svc-replace-b-${suffix}`;
      const network = yield* defaultNetworking();
      const taskDefArn = yield* registerTaskDef(suffix);

      try {
        const a = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("RenameSvcCluster", {});
            return yield* Service("RenameSvc", {
              cluster,
              serviceName: nameA,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );
        expect(a.serviceName).toEqual(nameA);

        const b = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("RenameSvcCluster", {});
            return yield* Service("RenameSvc", {
              cluster,
              serviceName: nameB,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );
        expect(b.serviceName).toEqual(nameB);
        expect(b.serviceArn).not.toEqual(a.serviceArn);

        // Old service must be gone after replace.
        yield* assertServiceDeleted(a.clusterArn, nameA);

        yield* stack.destroy();
        yield* assertServiceDeleted(b.clusterArn, nameB);
      } finally {
        yield* deregisterTaskDef(taskDefArn).pipe(Effect.ignore);
      }
    }),
  { timeout: TIMEOUT },
);

test.provider(
  "destroying an already-deleted service is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const network = yield* defaultNetworking();
      const taskDefArn = yield* registerTaskDef(suffix);

      try {
        const svc = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("DoubleDestroySvcCluster", {});
            return yield* Service("DoubleDestroySvc", {
              cluster,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );

        // Delete out of band, then ask the engine to destroy. Provider's
        // `delete` must catch `ServiceNotFoundException` and complete cleanly.
        yield* ecs.updateService({
          cluster: svc.clusterArn,
          service: svc.serviceName,
          desiredCount: 0,
        });
        yield* ecs.deleteService({
          cluster: svc.clusterArn,
          service: svc.serviceName,
          force: true,
        });
        yield* assertServiceDeleted(svc.clusterArn, svc.serviceName);

        yield* stack.destroy();
      } finally {
        yield* deregisterTaskDef(taskDefArn).pipe(Effect.ignore);
      }
    }),
  { timeout: TIMEOUT },
);

test.provider(
  "adopt(true) re-tags a foreign service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const serviceName = `alchemy-test-svc-takeover-${suffix}`;
      const network = yield* defaultNetworking();
      const taskDefArn = yield* registerTaskDef(suffix);

      try {
        // Stand up a Cluster via Alchemy so it's owned and tagged. The
        // service inside is foreign — created out-of-band with a different
        // tag set.
        const initialDeploy = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cluster("ForeignSvcCluster", {});
          }),
        );
        const clusterArn = initialDeploy.clusterArn;

        const created = yield* ecs.createService({
          cluster: clusterArn,
          serviceName,
          taskDefinition: taskDefArn,
          desiredCount: 0,
          launchType: "FARGATE",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: network.subnets,
              assignPublicIp: "DISABLED",
            },
          },
          tags: [{ key: "owner", value: "external" }],
          enableECSManagedTags: false,
        });
        const foreignArn = created.service!.serviceArn!;

        const takenOver = yield* stack
          .deploy(
            Effect.gen(function* () {
              const cluster = yield* Cluster("ForeignSvcCluster", {});
              return yield* Service("Foreign", {
                cluster,
                serviceName,
                task: {
                  taskDefinitionArn: taskDefArn,
                  containerName: "app",
                  port: 80,
                },
                vpcId: network.vpcId,
                subnets: network.subnets,
                desiredCount: 0,
              });
            }),
          )
          .pipe(adopt(true));

        expect(takenOver.serviceName).toEqual(serviceName);
        expect(takenOver.serviceArn).toEqual(foreignArn as `arn:aws:ecs:${string}`);

        // After adopt(true) reconcile should have re-tagged the service.
        const observed = yield* describeOne(clusterArn, serviceName);
        const tags = tagMapOf(observed);
        expect(tags[TAG_FQN]).toBeDefined();
        expect(tags[TAG_STAGE]).toBeDefined();
        // The foreign user-defined tag should still be present.
        expect(tags.owner).toEqual("external");

        yield* stack.destroy();
        yield* assertServiceDeleted(clusterArn, serviceName);
      } finally {
        yield* deregisterTaskDef(taskDefArn).pipe(Effect.ignore);
      }
    }),
  { timeout: TIMEOUT },
);

test.provider(
  "foreign-tagged service requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const serviceName = `alchemy-test-svc-foreign-${suffix}`;
      const network = yield* defaultNetworking();
      const taskDefArn = yield* registerTaskDef(suffix);

      try {
        // Deploy with this stack so internal tags get set on the service.
        const original = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("ForeignNeedsAdopt", {});
            return yield* Service("Original", {
              cluster,
              serviceName,
              task: {
                taskDefinitionArn: taskDefArn,
                containerName: "app",
                port: 80,
              },
              vpcId: network.vpcId,
              subnets: network.subnets,
              desiredCount: 0,
            });
          }),
        );

        // Forget the resource from state so the next deploy rides through
        // the read → Unowned path. The cluster stays owned.
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
              const cluster = yield* Cluster("ForeignNeedsAdopt", {});
              return yield* Service("Different", {
                cluster,
                serviceName,
                task: {
                  taskDefinitionArn: taskDefArn,
                  containerName: "app",
                  port: 80,
                },
                vpcId: network.vpcId,
                subnets: network.subnets,
                desiredCount: 0,
              });
            }),
          )
          .pipe(adopt(true));

        expect(adopted.serviceArn).toEqual(original.serviceArn);

        yield* stack.destroy();
        yield* assertServiceDeleted(original.clusterArn, serviceName);
      } finally {
        yield* deregisterTaskDef(taskDefArn).pipe(Effect.ignore);
      }
    }),
  { timeout: TIMEOUT },
);
