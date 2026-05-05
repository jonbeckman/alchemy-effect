import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Stream } from "@/AWS/Kinesis";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.Kinesis.Stream", () => {
  test.provider(
    "create and delete stream with default props",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("DefaultStream");
          }),
        );

        expect(stream.streamName).toBeDefined();
        expect(stream.streamArn).toBeDefined();
        expect(stream.streamStatus).toEqual("ACTIVE");

        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
          "ACTIVE",
        );
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("ON_DEMAND");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create, update, delete on-demand stream with tags",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("TestStream", {
              streamMode: "ON_DEMAND",
              tags: { Environment: "test" },
            });
          }),
        );

        // Verify the stream was created
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
          "ACTIVE",
        );
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("ON_DEMAND");
        expect(
          streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(24);

        // Verify tags
        const tagging = yield* Kinesis.listTagsForStream({
          StreamName: stream.streamName,
        });
        expect(tagging.Tags).toContainEqual({
          Key: "Environment",
          Value: "test",
        });

        // Update the stream - increase retention period and update tags
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("TestStream", {
              streamMode: "ON_DEMAND",
              retentionPeriodHours: 48,
              tags: { Environment: "production", Team: "platform" },
            });
          }),
        );

        // Verify the retention period was updated
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(48);

        // Verify tags were updated
        const updatedTagging = yield* Kinesis.listTagsForStream({
          StreamName: stream.streamName,
        });
        expect(updatedTagging.Tags).toContainEqual({
          Key: "Environment",
          Value: "production",
        });
        expect(updatedTagging.Tags).toContainEqual({
          Key: "Team",
          Value: "platform",
        });

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create provisioned stream with shards",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ProvisionedStream", {
              streamMode: "PROVISIONED",
              shardCount: 2,
            });
          }),
        );

        // Verify the stream was created with shards
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
          "ACTIVE",
        );
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("PROVISIONED");
        expect(
          streamDescription.StreamDescriptionSummary.OpenShardCount,
        ).toEqual(2);

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "update provisioned stream shard count",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );

        // Verify initial shard count
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.OpenShardCount,
        ).toEqual(1);

        // Update shard count
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardStream", {
              streamMode: "PROVISIONED",
              shardCount: 2,
            });
          }),
        );

        // Verify shard count was updated
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.OpenShardCount,
        ).toEqual(2);

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 300_000 },
  );

  test.provider(
    "create stream with custom name",
    (stack) =>
      Effect.gen(function* () {
        const customName = `test-custom-kinesis-stream-custom-name-stream`;

        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("CustomNameStream", {
              streamName: customName,
            });
          }),
        );

        expect(stream.streamName).toEqual(customName);
        expect(stream.streamArn).toContain(customName);

        // Verify the stream exists
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: customName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamName).toEqual(
          customName,
        );

        yield* stack.destroy();

        yield* assertStreamDeleted(customName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create stream with encryption",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("EncryptedStream", {
              encryption: true,
            });
          }),
        );

        // Verify the stream has encryption enabled
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.EncryptionType,
        ).toEqual("KMS");

        // Update to disable encryption
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("EncryptedStream", {
              encryption: false,
            });
          }),
        );

        // Verify encryption is disabled
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.EncryptionType,
        ).toEqual("NONE");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create stream with enhanced monitoring and update metrics",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("MonitoredStream", {
              shardLevelMetrics: ["IncomingBytes", "OutgoingRecords"],
            });
          }),
        );

        // Verify enhanced monitoring is enabled
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        const metrics =
          streamDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
            ?.ShardLevelMetrics ?? [];
        expect(metrics).toContain("IncomingBytes");
        expect(metrics).toContain("OutgoingRecords");

        // Update metrics - add some, remove some
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("MonitoredStream", {
              shardLevelMetrics: [
                "IncomingBytes",
                "IncomingRecords",
                "IteratorAgeMilliseconds",
              ],
            });
          }),
        );

        // Verify metrics were updated
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        const updatedMetrics =
          updatedDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
            ?.ShardLevelMetrics ?? [];
        expect(updatedMetrics).toContain("IncomingBytes");
        expect(updatedMetrics).toContain("IncomingRecords");
        expect(updatedMetrics).toContain("IteratorAgeMilliseconds");
        expect(updatedMetrics).not.toContain("OutgoingRecords");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "idempotent create - stream already exists",
    (stack) =>
      Effect.gen(function* () {
        // First create
        const stream1 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("IdempotentStream", {});
          }),
        );
        const streamName = stream1.streamName;

        // Second create (should be idempotent)
        const stream2 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("IdempotentStream", {});
          }),
        );
        expect(stream2.streamName).toEqual(streamName);

        yield* stack.destroy();

        yield* assertStreamDeleted(streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "switch stream mode from provisioned to on-demand",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ModeChangeStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );

        // Verify provisioned mode
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("PROVISIONED");

        // Update to on-demand mode
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ModeChangeStream", {
              streamMode: "ON_DEMAND",
            });
          }),
        );

        // Verify on-demand mode
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("ON_DEMAND");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 300_000 },
  );

  test.provider(
    "decrease retention period",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RetentionStream", {
              retentionPeriodHours: 48,
            });
          }),
        );

        // Verify initial retention period
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(48);

        // Decrease retention period back to default
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RetentionStream", {
              retentionPeriodHours: 24,
            });
          }),
        );

        // Verify retention period was decreased
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(24);

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "update stream resource policy and max record size",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("PolicyStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );

        const policy = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowSameAccountDescribe",
              Effect: "Allow",
              Principal: {
                AWS: `arn:aws:iam::${stream.streamArn.split(":")[4]}:root`,
              },
              Action: ["kinesis:DescribeStreamSummary"],
              Resource: stream.streamArn,
            },
          ],
        });

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("PolicyStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
              resourcePolicy: policy,
              maxRecordSizeInKiB: 2048,
            });
          }),
        );

        expect(updated.resourcePolicy).toContain("AllowSameAccountDescribe");
        expect(updated.maxRecordSizeInKiB).toEqual(2048);

        const policyResponse = yield* Kinesis.getResourcePolicy({
          ResourceARN: stream.streamArn,
        });
        expect(policyResponse.Policy).toContain("AllowSameAccountDescribe");

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(summary.StreamDescriptionSummary.MaxRecordSizeInKiB).toEqual(
          2048,
        );

        yield* stack.destroy();
        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "update warm throughput when account supports it",
    (stack) =>
      Effect.gen(function* () {
        const accountSettings = yield* Kinesis.describeAccountSettings({});
        const status =
          accountSettings.MinimumThroughputBillingCommitment?.Status ??
          "DISABLED";

        if (status === "DISABLED") {
          return;
        }

        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("WarmThroughputStream");
          }),
        );

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("WarmThroughputStream", {
              warmThroughputMiBps: 10,
            });
          }),
        );

        expect(updated.warmThroughput?.targetMiBps).toEqual(10);

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          summary.StreamDescriptionSummary.WarmThroughput?.TargetMiBps,
        ).toEqual(10);

        yield* stack.destroy();
        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "owned stream (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const streamName = `alchemy-test-kinesis-adopt-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("AdoptableStream", { streamName });
          }),
        );
        expect(initial.streamName).toEqual(streamName);

        // Wipe state — the stream stays in Kinesis.
        yield* Effect.gen(function* () {
          const state = yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableStream",
          });
        }).pipe(Effect.provide(stack.state));

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("AdoptableStream", { streamName });
          }),
        );

        expect(adopted.streamArn).toEqual(initial.streamArn);

        yield* stack.destroy();
        yield* assertStreamDeleted(streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "foreign-tagged stream requires adopt(true) to take over",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const streamName = `alchemy-test-kinesis-takeover-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("Original", { streamName });
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

        const takenOver = yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* Stream("Different", { streamName });
            }),
          )
          .pipe(adopt(true));

        expect(takenOver.streamName).toEqual(streamName);

        const tagsResp = yield* Kinesis.listTagsForResource({
          ResourceARN: takenOver.streamArn,
        });
        const tagMap = Object.fromEntries(
          (tagsResp.Tags ?? [])
            .filter(
              (t): t is { Key: string; Value: string } =>
                typeof t.Value === "string",
            )
            .map((t) => [t.Key, t.Value]),
        );
        expect(tagMap["alchemy::id"]).toEqual("Different");

        yield* stack.destroy();
        yield* assertStreamDeleted(streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "redeploy with same props is a no-op (reconcile is idempotent)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("IdempotentRedeployStream", {
              retentionPeriodHours: 36,
            });
          }),
        );

        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("IdempotentRedeployStream", {
              retentionPeriodHours: 36,
            });
          }),
        );
        expect(second.streamArn).toEqual(initial.streamArn);
        expect(second.streamName).toEqual(initial.streamName);
        expect(second.retentionPeriodHours).toEqual(36);

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: second.streamName,
        });
        expect(summary.StreamDescriptionSummary.RetentionPeriodHours).toEqual(
          36,
        );

        yield* stack.destroy();
        yield* assertStreamDeleted(initial.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "reconcile resets shard count drift",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardDriftStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );
        expect(initial.openShardCount).toEqual(1);

        // Mutate shard count out of band.
        yield* Kinesis.updateShardCount({
          StreamName: initial.streamName,
          TargetShardCount: 2,
          ScalingType: "UNIFORM_SCALING",
        });
        yield* waitForShardCount(initial.streamName, 2);

        // Re-deploy with the original shard count — reconcile must converge.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardDriftStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );
        expect(redeployed.streamArn).toEqual(initial.streamArn);
        yield* waitForShardCount(initial.streamName, 1);

        yield* stack.destroy();
        yield* assertStreamDeleted(initial.streamName);
      }),
    { timeout: 360_000 },
  );

  test.provider(
    "reconcile resets retention period drift",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RetentionDriftStream", {
              retentionPeriodHours: 24,
            });
          }),
        );

        // Drift retention out of band.
        yield* Kinesis.increaseStreamRetentionPeriod({
          StreamName: initial.streamName,
          RetentionPeriodHours: 72,
        });
        yield* waitForRetentionHours(initial.streamName, 72);

        // Re-deploy with the original retention — reconcile must reset it.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RetentionDriftStream", {
              retentionPeriodHours: 24,
            });
          }),
        );
        yield* waitForRetentionHours(initial.streamName, 24);

        yield* stack.destroy();
        yield* assertStreamDeleted(initial.streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "reconcile resets shard-level metrics drift",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("MetricsDriftStream", {
              shardLevelMetrics: ["IncomingBytes"],
            });
          }),
        );

        // Enable an extra metric out of band.
        yield* Kinesis.enableEnhancedMonitoring({
          StreamName: initial.streamName,
          ShardLevelMetrics: ["OutgoingBytes"],
        });

        // Re-deploy with the original metrics — reconcile must remove
        // the drifted metric.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("MetricsDriftStream", {
              shardLevelMetrics: ["IncomingBytes"],
            });
          }),
        );

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: initial.streamName,
        });
        const metrics =
          summary.StreamDescriptionSummary.EnhancedMonitoring?.[0]
            ?.ShardLevelMetrics ?? [];
        expect(metrics).toContain("IncomingBytes");
        expect(metrics).not.toContain("OutgoingBytes");

        yield* stack.destroy();
        yield* assertStreamDeleted(initial.streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "reconcile re-creates a stream that was deleted out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const streamName = `alchemy-test-kinesis-recreate-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RecreateStream", { streamName });
          }),
        );

        // Delete the stream out of band and wait for AWS to fully drop it.
        yield* Kinesis.deleteStream({
          StreamName: initial.streamName,
          EnforceConsumerDeletion: true,
        });
        yield* assertStreamDeleted(streamName);

        // Re-deploying must converge by re-creating.
        const recreated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RecreateStream", { streamName });
          }),
        );

        expect(recreated.streamName).toEqual(streamName);
        expect(recreated.streamStatus).toEqual("ACTIVE");

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: streamName,
        });
        expect(summary.StreamDescriptionSummary.StreamStatus).toEqual("ACTIVE");

        yield* stack.destroy();
        yield* assertStreamDeleted(streamName);
      }),
    { timeout: 360_000 },
  );

  test.provider(
    "changing streamName triggers replace, old stream is deleted",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const suffix = Math.random().toString(36).slice(2, 8);
        const nameA = `alchemy-test-kinesis-replace-a-${suffix}`;
        const nameB = `alchemy-test-kinesis-replace-b-${suffix}`;

        const a = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RenameStream", { streamName: nameA });
          }),
        );
        expect(a.streamName).toEqual(nameA);

        const b = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RenameStream", { streamName: nameB });
          }),
        );
        expect(b.streamName).toEqual(nameB);
        expect(b.streamArn).not.toEqual(a.streamArn);

        // The old stream must be gone after replace.
        yield* assertStreamDeleted(nameA);

        yield* stack.destroy();
        yield* assertStreamDeleted(nameB);
      }),
    { timeout: 360_000 },
  );

  test.provider(
    "scale provisioned shard count up and back down",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardScaleStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );
        expect(initial.openShardCount).toEqual(1);

        const scaledUp = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardScaleStream", {
              streamMode: "PROVISIONED",
              shardCount: 2,
            });
          }),
        );
        expect(scaledUp.streamArn).toEqual(initial.streamArn);
        yield* waitForShardCount(initial.streamName, 2);

        const scaledDown = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardScaleStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );
        expect(scaledDown.streamArn).toEqual(initial.streamArn);
        yield* waitForShardCount(initial.streamName, 1);

        yield* stack.destroy();
        yield* assertStreamDeleted(initial.streamName);
      }),
    { timeout: 480_000 },
  );

  test.provider(
    "toggle stream mode on-demand <-> provisioned",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const onDemand = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ModeToggleStream", {
              streamMode: "ON_DEMAND",
            });
          }),
        );
        expect(onDemand.streamMode).toEqual("ON_DEMAND");

        const provisioned = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ModeToggleStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );
        expect(provisioned.streamArn).toEqual(onDemand.streamArn);

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: provisioned.streamName,
        });
        expect(
          summary.StreamDescriptionSummary.StreamModeDetails?.StreamMode,
        ).toEqual("PROVISIONED");

        const backToOnDemand = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ModeToggleStream", {
              streamMode: "ON_DEMAND",
            });
          }),
        );
        expect(backToOnDemand.streamArn).toEqual(onDemand.streamArn);

        const finalSummary = yield* Kinesis.describeStreamSummary({
          StreamName: backToOnDemand.streamName,
        });
        expect(
          finalSummary.StreamDescriptionSummary.StreamModeDetails?.StreamMode,
        ).toEqual("ON_DEMAND");

        yield* stack.destroy();
        yield* assertStreamDeleted(onDemand.streamName);
      }),
    { timeout: 480_000 },
  );

  test.provider(
    "destroying an already-deleted stream is a no-op",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("DoubleDestroyStream");
          }),
        );

        // Delete the stream out of band, then ask the engine to destroy it.
        // Provider's `delete` must catch ResourceNotFoundException and
        // complete cleanly.
        yield* Kinesis.deleteStream({
          StreamName: stream.streamName,
          EnforceConsumerDeletion: true,
        });
        yield* assertStreamDeleted(stream.streamName);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  class ShardCountMismatch extends Data.TaggedError("ShardCountMismatch") {}
  class RetentionMismatch extends Data.TaggedError("RetentionMismatch") {}

  /** Poll DescribeStreamSummary until the stream reports the expected shard count. */
  const waitForShardCount = Effect.fn(function* (
    streamName: string,
    expected: number,
  ) {
    yield* Effect.gen(function* () {
      const { StreamDescriptionSummary } = yield* Kinesis.describeStreamSummary(
        { StreamName: streamName },
      );
      if (
        StreamDescriptionSummary.StreamStatus !== "ACTIVE" ||
        StreamDescriptionSummary.OpenShardCount !== expected
      ) {
        return yield* Effect.fail(new ShardCountMismatch());
      }
    }).pipe(
      Effect.retry({
        while: (e: { _tag: string }) =>
          e._tag === "ShardCountMismatch" || e._tag === "ParseError",
        schedule: Schedule.exponential(500).pipe(
          Schedule.both(Schedule.recurs(60)),
        ),
      }),
    );
  });

  /** Poll DescribeStreamSummary until the stream reports the expected retention period. */
  const waitForRetentionHours = Effect.fn(function* (
    streamName: string,
    expected: number,
  ) {
    yield* Effect.gen(function* () {
      const { StreamDescriptionSummary } = yield* Kinesis.describeStreamSummary(
        { StreamName: streamName },
      );
      if (StreamDescriptionSummary.RetentionPeriodHours !== expected) {
        return yield* Effect.fail(new RetentionMismatch());
      }
    }).pipe(
      Effect.retry({
        while: (e: { _tag: string }) =>
          e._tag === "RetentionMismatch" || e._tag === "ParseError",
        schedule: Schedule.fixed("500 millis").pipe(
          Schedule.both(Schedule.recurs(40)),
        ),
      }),
    );
  });

  class StreamStillExists extends Data.TaggedError("StreamStillExists") {}

  const assertStreamDeleted = Effect.fn(function* (streamName: string) {
    yield* Kinesis.describeStreamSummary({
      StreamName: streamName,
    }).pipe(
      Effect.flatMap(() => Effect.fail(new StreamStillExists())),
      Effect.retry({
        while: (e: { _tag: string }) =>
          e._tag === "StreamStillExists" ||
          // During stream deletion, AWS may return incomplete responses that fail parsing
          e._tag === "ParseError",
        schedule: Schedule.exponential(500).pipe(
          Schedule.both(Schedule.recurs(30)),
        ),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
  });
});
