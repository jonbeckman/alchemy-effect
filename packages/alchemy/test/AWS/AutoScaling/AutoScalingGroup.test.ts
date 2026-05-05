import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { AutoScalingGroup } from "@/AWS/AutoScaling";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// ASG tests require pre-existing infrastructure: a launch template and
// at least one VPC subnet ID. Gate the suite behind env vars so CI doesn't
// try to spin up real EC2 instances.
//
//   TEST_LAUNCH_TEMPLATE_ID=lt-xxxxxxxx
//   TEST_SUBNET_IDS=subnet-aaaa,subnet-bbbb
const TEST_LAUNCH_TEMPLATE_ID = process.env.TEST_LAUNCH_TEMPLATE_ID as
  | `lt-${string}`
  | undefined;
const TEST_SUBNET_IDS = (process.env.TEST_SUBNET_IDS?.split(",") ??
  []) as `subnet-${string}`[];
const skip = !TEST_LAUNCH_TEMPLATE_ID || TEST_SUBNET_IDS.length === 0;

const launchTemplate = () => ({
  launchTemplateId: TEST_LAUNCH_TEMPLATE_ID!,
});

test.provider.skipIf(skip)("redeploy with same props is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const first = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AutoScalingGroup("Asg", {
          launchTemplate: launchTemplate(),
          subnetIds: TEST_SUBNET_IDS,
          minSize: 0,
          maxSize: 1,
          desiredCapacity: 0,
        });
      }),
    );

    const second = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AutoScalingGroup("Asg", {
          launchTemplate: launchTemplate(),
          subnetIds: TEST_SUBNET_IDS,
          minSize: 0,
          maxSize: 1,
          desiredCapacity: 0,
        });
      }),
    );

    expect(second.autoScalingGroupArn).toEqual(first.autoScalingGroupArn);
    expect(second.minSize).toEqual(0);
    expect(second.maxSize).toEqual(1);
    expect(second.desiredCapacity).toEqual(0);

    yield* stack.destroy();
    yield* assertGroupDeleted(first.autoScalingGroupName);
  }),
);

test.provider.skipIf(skip)(
  "reconcile resets desiredCapacity mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AutoScalingGroup("AsgDrift", {
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 0,
            maxSize: 2,
            desiredCapacity: 0,
          });
        }),
      );

      // Mutate desiredCapacity out-of-band via the raw SDK.
      yield* autoscaling.setDesiredCapacity({
        AutoScalingGroupName: created.autoScalingGroupName,
        DesiredCapacity: 1,
        HonorCooldown: false,
      } as any);

      const reconverged = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AutoScalingGroup("AsgDrift", {
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 0,
            maxSize: 2,
            desiredCapacity: 0,
          });
        }),
      );

      expect(reconverged.desiredCapacity).toEqual(0);

      yield* stack.destroy();
      yield* assertGroupDeleted(created.autoScalingGroupName);
    }),
);

test.provider.skipIf(skip)(
  "changing autoScalingGroupName triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AutoScalingGroup("AsgReplace", {
            autoScalingGroupName: "alchemy-asg-replace-a",
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 0,
            maxSize: 1,
          });
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AutoScalingGroup("AsgReplace", {
            autoScalingGroupName: "alchemy-asg-replace-b",
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 0,
            maxSize: 1,
          });
        }),
      );

      expect(replaced.autoScalingGroupName).not.toEqual(
        original.autoScalingGroupName,
      );
      yield* assertGroupDeleted(original.autoScalingGroupName);

      yield* stack.destroy();
      yield* assertGroupDeleted(replaced.autoScalingGroupName);
    }),
);

test.provider.skipIf(skip)(
  "in-place modification of minSize/maxSize",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const before = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AutoScalingGroup("AsgSize", {
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 0,
            maxSize: 1,
            desiredCapacity: 0,
          });
        }),
      );

      const after = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AutoScalingGroup("AsgSize", {
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 1,
            maxSize: 3,
            desiredCapacity: 1,
          });
        }),
      );

      expect(after.autoScalingGroupArn).toEqual(before.autoScalingGroupArn);
      expect(after.minSize).toEqual(1);
      expect(after.maxSize).toEqual(3);
      expect(after.desiredCapacity).toEqual(1);

      yield* stack.destroy();
      yield* assertGroupDeleted(before.autoScalingGroupName);
    }),
);

test.provider.skipIf(skip)(
  "destroying an already-deleted ASG is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AutoScalingGroup("AsgPreDel", {
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 0,
            maxSize: 1,
            desiredCapacity: 0,
          });
        }),
      );

      // Out-of-band delete using the raw SDK.
      yield* autoscaling
        .deleteAutoScalingGroup({
          AutoScalingGroupName: created.autoScalingGroupName,
          ForceDelete: true,
        } as any)
        .pipe(Effect.catch(() => Effect.void));
      yield* assertGroupDeleted(created.autoScalingGroupName);

      // stack.destroy() now must succeed without raising.
      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)("adopt(true) re-tags a foreign ASG", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const groupName = `alchemy-asg-adopt-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const original = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AutoScalingGroup("Original", {
          autoScalingGroupName: groupName,
          launchTemplate: launchTemplate(),
          subnetIds: TEST_SUBNET_IDS,
          minSize: 0,
          maxSize: 1,
          desiredCapacity: 0,
        });
      }),
    );

    // Wipe state so the engine sees the ASG as foreign.
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
          return yield* AutoScalingGroup("Different", {
            autoScalingGroupName: groupName,
            launchTemplate: launchTemplate(),
            subnetIds: TEST_SUBNET_IDS,
            minSize: 0,
            maxSize: 1,
            desiredCapacity: 0,
          });
        }),
      )
      .pipe(adopt(true));

    expect(adopted.autoScalingGroupArn).toEqual(original.autoScalingGroupArn);
    expect(adopted.tags["alchemy::id"]).toEqual("Different");

    yield* stack.destroy();
    yield* assertGroupDeleted(groupName);
  }),
);

class AutoScalingGroupStillExists extends Data.TaggedError(
  "AutoScalingGroupStillExists",
) {}

const assertGroupDeleted = Effect.fn(function* (name: string) {
  yield* autoscaling
    .describeAutoScalingGroups({ AutoScalingGroupNames: [name] })
    .pipe(
      Effect.flatMap((result) =>
        (result.AutoScalingGroups ?? []).length === 0
          ? Effect.void
          : Effect.fail(new AutoScalingGroupStillExists()),
      ),
      Effect.retry({
        while: (e) => e._tag === "AutoScalingGroupStillExists",
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(60)),
        ),
      }),
    );
});
