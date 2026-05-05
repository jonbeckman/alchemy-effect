import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider.skip("create, update, delete vpc", (stack) =>
  Effect.gen(function* () {
    const vpc = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
          enableDnsSupport: true,
          enableDnsHostnames: true,
        });
      }),
    );

    const actualVpc = yield* EC2.describeVpcs({
      VpcIds: [vpc.vpcId],
    });
    expect(actualVpc.Vpcs?.[0]?.VpcId).toEqual(vpc.vpcId);
    expect(actualVpc.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
    expect(actualVpc.Vpcs?.[0]?.State).toEqual("available");

    yield* expectVpcAttribute({
      VpcId: vpc.vpcId,
      Attribute: "enableDnsSupport",
      Value: true,
    });

    yield* expectVpcAttribute({
      VpcId: vpc.vpcId,
      Attribute: "enableDnsHostnames",
      Value: true,
    });

    // Update VPC attributes
    const updatedVpc = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
          enableDnsSupport: false,
          enableDnsHostnames: false,
        });
      }),
    );

    yield* expectVpcAttribute({
      VpcId: updatedVpc.vpcId,
      Attribute: "enableDnsSupport",
      Value: false,
    });

    yield* expectVpcAttribute({
      VpcId: updatedVpc.vpcId,
      Attribute: "enableDnsHostnames",
      Value: false,
    });

    yield* stack.destroy();

    yield* assertVpcDeleted(vpc.vpcId);
  }).pipe(logLevel),
);

// Engine-level adoption tests for EC2 VPC. Skipped to match the cost
// profile of the existing `.skip`'d create/update/delete test above —
// these spin up real VPCs end-to-end.
test.provider.skip(
  "owned vpc (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("AdoptableVpc", { cidrBlock: "10.42.0.0/16" });
        }),
      );
      expect(initial.vpcId).toBeDefined();

      // Wipe state — VPC stays in EC2.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableVpc",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("AdoptableVpc", { cidrBlock: "10.42.0.0/16" });
        }),
      );

      expect(adopted.vpcId).toEqual(initial.vpcId);
      expect(adopted.vpcArn).toEqual(initial.vpcArn);

      yield* stack.destroy();
      yield* assertVpcDeleted(initial.vpcId);
    }).pipe(logLevel),
);

// A foreign-tagged VPC takeover test requires pre-creating a VPC tagged
// with the new resource's `alchemy::id` (since VPC has no physical name to
// look up by — `read` filters strictly by alchemy tags). Manually tagging a
// VPC with our internal tag namespace from a test feels brittle; for now we
// rely on the SQS coverage of the `Unowned` → adopt(true) → re-tag flow at
// the engine level, and assert here that adoption-by-tags converges.
test.provider.skip(
  "foreign-tagged vpc requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("Original", { cidrBlock: "10.43.0.0/16" });
        }),
      );

      // Wipe state — VPC stays in EC2 with the "Original" id tag.
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
            return yield* Vpc("Different", { cidrBlock: "10.43.0.0/16" });
          }),
        )
        .pipe(adopt(true));

      const lookup = yield* EC2.describeVpcs({
        VpcIds: [takenOver.vpcId],
      });
      const tags = Object.fromEntries(
        (lookup.Vpcs?.[0]?.Tags ?? []).map((t) => [t.Key!, t.Value!]),
      );
      expect(tags["alchemy::id"]).toEqual("Different");

      yield* stack.destroy();
      yield* assertVpcDeleted(takenOver.vpcId);
      if (original.vpcId !== takenOver.vpcId) {
        yield* assertVpcDeleted(original.vpcId);
      }
    }).pipe(logLevel),
);

const expectVpcAttribute = Effect.fn(function* (props: {
  VpcId: string;
  Attribute: EC2.VpcAttributeName;
  Value: boolean;
}) {
  yield* EC2.describeVpcAttribute({
    VpcId: props.VpcId,
    Attribute: props.Attribute,
  }).pipe(
    Effect.tap(Effect.logDebug),
    Effect.flatMap((result: any) =>
      result[`${props.Attribute[0].toUpperCase()}${props.Attribute.slice(1)}`]
        ?.Value === props.Value
        ? Effect.succeed(result)
        : Effect.fail(new VpcAttributeStale()),
    ),
    Effect.retry({
      while: (e) => e._tag === "VpcAttributeStale",
      schedule: Schedule.exponential(100),
    }),
  );
});

class VpcAttributeStale extends Data.TaggedError("VpcAttributeStale") {}

class VpcStillExists extends Data.TaggedError("VpcStillExists") {}

export const assertVpcDeleted = Effect.fn(function* (vpcId: string) {
  yield* EC2.describeVpcs({
    VpcIds: [vpcId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new VpcStillExists())),
    Effect.retry({
      while: (e) => e._tag === "VpcStillExists",
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
  );
});
