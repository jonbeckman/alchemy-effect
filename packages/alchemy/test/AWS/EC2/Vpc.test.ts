import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
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

test.provider("create, update, delete vpc", (stack) =>
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

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("IdempotentVpc", {
            cidrBlock: "10.10.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
        }),
      );

      // Re-deploy with identical props. The result should match the
      // original VPC by id/CIDR — no replace, no drift.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("IdempotentVpc", {
            cidrBlock: "10.10.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
        }),
      );
      expect(second.vpcId).toEqual(initial.vpcId);
      expect(second.vpcArn).toEqual(initial.vpcArn);
      expect(second.cidrBlock).toEqual("10.10.0.0/16");

      yield* expectVpcAttribute({
        VpcId: second.vpcId,
        Attribute: "enableDnsSupport",
        Value: true,
      });
      yield* expectVpcAttribute({
        VpcId: second.vpcId,
        Attribute: "enableDnsHostnames",
        Value: true,
      });

      yield* stack.destroy();
      yield* assertVpcDeleted(initial.vpcId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets DNS attributes mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const vpc = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DriftDnsVpc", {
            cidrBlock: "10.11.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
        }),
      );

      // Mutate DNS attrs out-of-band via the raw SDK.
      yield* EC2.modifyVpcAttribute({
        VpcId: vpc.vpcId,
        EnableDnsSupport: { Value: false },
      });
      yield* EC2.modifyVpcAttribute({
        VpcId: vpc.vpcId,
        EnableDnsHostnames: { Value: false },
      });
      yield* expectVpcAttribute({
        VpcId: vpc.vpcId,
        Attribute: "enableDnsSupport",
        Value: false,
      });
      yield* expectVpcAttribute({
        VpcId: vpc.vpcId,
        Attribute: "enableDnsHostnames",
        Value: false,
      });

      // Re-deploying with the original desired props must converge cloud
      // state back to the desired values.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DriftDnsVpc", {
            cidrBlock: "10.11.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
        }),
      );
      expect(redeployed.vpcId).toEqual(vpc.vpcId);

      yield* expectVpcAttribute({
        VpcId: redeployed.vpcId,
        Attribute: "enableDnsSupport",
        Value: true,
      });
      yield* expectVpcAttribute({
        VpcId: redeployed.vpcId,
        Attribute: "enableDnsHostnames",
        Value: true,
      });

      yield* stack.destroy();
      yield* assertVpcDeleted(vpc.vpcId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets tags mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const vpc = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DriftTagsVpc", {
            cidrBlock: "10.12.0.0/16",
            tags: { Environment: "dev", Owner: "alchemy" },
          });
        }),
      );

      // Add a foreign tag and overwrite an existing one out-of-band.
      yield* EC2.createTags({
        Resources: [vpc.vpcId],
        Tags: [
          { Key: "Environment", Value: "drifted" },
          { Key: "Foreign", Value: "tag" },
        ],
      });

      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DriftTagsVpc", {
            cidrBlock: "10.12.0.0/16",
            tags: { Environment: "dev", Owner: "alchemy" },
          });
        }),
      );
      expect(redeployed.vpcId).toEqual(vpc.vpcId);

      const observed = yield* EC2.describeVpcs({ VpcIds: [redeployed.vpcId] });
      const tagMap = Object.fromEntries(
        (observed.Vpcs?.[0]?.Tags ?? []).map((t) => [t.Key!, t.Value!]),
      );
      // Drifted tag is reset, foreign tag is removed, internal tags remain.
      expect(tagMap.Environment).toEqual("dev");
      expect(tagMap.Owner).toEqual("alchemy");
      expect(tagMap.Foreign).toBeUndefined();
      expect(tagMap["alchemy::id"]).toEqual("DriftTagsVpc");

      yield* stack.destroy();
      yield* assertVpcDeleted(vpc.vpcId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a VPC that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("RecreateVpc", { cidrBlock: "10.13.0.0/16" });
        }),
      );

      // Delete the VPC via the raw SDK.
      yield* EC2.deleteVpc({ VpcId: initial.vpcId });
      yield* assertVpcDeleted(initial.vpcId);

      // Re-deploying must converge by re-creating. The state still
      // references the old vpcId; the reconciler observes
      // `InvalidVpcID.NotFound`, falls through to `createVpc`, and
      // produces a brand-new VPC with the same logical id.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("RecreateVpc", { cidrBlock: "10.13.0.0/16" });
        }),
      );
      expect(recreated.vpcId).not.toEqual(initial.vpcId);
      expect(recreated.cidrBlock).toEqual("10.13.0.0/16");

      yield* stack.destroy();
      yield* assertVpcDeleted(recreated.vpcId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing cidrBlock triggers replace; old VPC is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("ReplaceVpc", { cidrBlock: "10.14.0.0/16" });
        }),
      );
      expect(a.cidrBlock).toEqual("10.14.0.0/16");

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("ReplaceVpc", { cidrBlock: "10.15.0.0/16" });
        }),
      );
      expect(b.cidrBlock).toEqual("10.15.0.0/16");
      expect(b.vpcId).not.toEqual(a.vpcId);

      // Old VPC must be torn down by the replacement flow.
      yield* assertVpcDeleted(a.vpcId);

      yield* stack.destroy();
      yield* assertVpcDeleted(b.vpcId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted VPC is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const vpc = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DoubleDestroyVpc", { cidrBlock: "10.16.0.0/16" });
        }),
      );

      // Delete out of band, then ask the engine to destroy. The provider
      // must catch InvalidVpcID.NotFound and complete cleanly.
      yield* EC2.deleteVpc({ VpcId: vpc.vpcId });
      yield* assertVpcDeleted(vpc.vpcId);

      yield* stack.destroy();
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
