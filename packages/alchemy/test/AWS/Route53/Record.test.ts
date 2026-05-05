import * as AWS from "@/AWS";
import { Record } from "@/AWS/Route53";
import * as Test from "@/Test/Vitest";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

const stripHostedZoneId = (id: string) =>
  id.replace(/^\/hostedzone\//, "");

const normalizeName = (name: string) =>
  name.endsWith(".") ? name : `${name}.`;

class RecordStillExists extends Data.TaggedError("RecordStillExists") {}

/**
 * Create an isolated public hosted zone for the test. Public zones don't
 * need to be delegated to be functional — Route53 still services them,
 * which is all the resource needs to exercise its lifecycle. We use a
 * randomized subdomain of `example.com` so collisions across parallel
 * test runs are essentially impossible.
 */
const createTestHostedZone = (logicalSuffix: string) =>
  Effect.gen(function* () {
    const domain = `alchemy-test-${logicalSuffix}-${randomSuffix()}.example.com`;
    const callerReference = `alchemy-test-${logicalSuffix}-${randomSuffix()}`;
    const response = yield* route53.createHostedZone({
      Name: domain,
      CallerReference: callerReference,
      HostedZoneConfig: {
        Comment: "alchemy-test record hardening",
        PrivateZone: false,
      },
    });
    return {
      domain,
      hostedZoneId: stripHostedZoneId(response.HostedZone.Id),
      changeId: response.ChangeInfo.Id,
    };
  });

/**
 * Tear down a test hosted zone, clearing any non-default records first.
 * Route53 forbids deleting a non-empty zone.
 */
const deleteTestHostedZone = (hostedZoneId: string) =>
  Effect.gen(function* () {
    // Delete every non-NS/SOA record. Route53 creates NS+SOA on zone
    // creation; those must remain untouched.
    yield* clearNonDefaultRecords(hostedZoneId);

    yield* route53
      .deleteHostedZone({ Id: hostedZoneId })
      .pipe(
        Effect.catchTag("NoSuchHostedZone", () => Effect.void),
        // The cleanup pass above issues async DELETEs — Route53 returns
        // `HostedZoneNotEmpty` until propagation finishes.
        Effect.retry({
          while: (e) =>
            (e as { _tag?: string })._tag === "HostedZoneNotEmpty",
          schedule: Schedule.fixed("3 seconds").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );
  });

const clearNonDefaultRecords = (hostedZoneId: string) =>
  Effect.gen(function* () {
    const response = yield* route53.listResourceRecordSets({
      HostedZoneId: hostedZoneId,
      MaxItems: 100,
    });
    const deletable = response.ResourceRecordSets.filter(
      (r) => r.Type !== "NS" && r.Type !== "SOA",
    );
    if (deletable.length === 0) return;

    const changeResp = yield* route53.changeResourceRecordSets({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: deletable.map((ResourceRecordSet) => ({
          Action: "DELETE",
          ResourceRecordSet,
        })),
      },
    });
    yield* waitForInSync(changeResp.ChangeInfo.Id);
  });

const waitForInSync = (changeId: string) =>
  route53.getChange({ Id: changeId }).pipe(
    Effect.flatMap((response) =>
      response.ChangeInfo.Status === "INSYNC"
        ? Effect.void
        : Effect.fail(new RecordStillExists()),
    ),
    Effect.retry({
      while: (e) => (e as { _tag?: string })._tag === "RecordStillExists",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
  );

const findRecord = (
  hostedZoneId: string,
  name: string,
  type: route53.RRType,
  setIdentifier?: string,
) =>
  route53
    .listResourceRecordSets({
      HostedZoneId: hostedZoneId,
      StartRecordName: normalizeName(name),
      StartRecordType: type,
      StartRecordIdentifier: setIdentifier,
      MaxItems: 100,
    })
    .pipe(
      Effect.map((response) =>
        response.ResourceRecordSets.find(
          (r) =>
            r.Name === normalizeName(name) &&
            r.Type === type &&
            (r.SetIdentifier ?? undefined) === setIdentifier,
        ),
      ),
    );

test.provider(
  "redeploy with same props is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* createTestHostedZone("noop");

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("NoopRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: `app.${zone.domain}`,
            type: "A",
            ttl: 300,
            records: ["192.0.2.10"],
          });
        }),
      );
      expect(initial.records).toEqual(["192.0.2.10"]);
      expect(initial.ttl).toEqual(300);

      // Re-deploy with identical props. Reconciler should observe the
      // record matches desired and skip the change-batch entirely.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("NoopRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: `app.${zone.domain}`,
            type: "A",
            ttl: 300,
            records: ["192.0.2.10"],
          });
        }),
      );
      expect(second.records).toEqual(["192.0.2.10"]);
      expect(second.ttl).toEqual(300);
      expect(second.name).toEqual(initial.name);

      yield* stack.destroy();
      yield* deleteTestHostedZone(zone.hostedZoneId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "reconcile resets TTL/values mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* createTestHostedZone("drift");
      const recordName = `drift.${zone.domain}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("DriftRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: recordName,
            type: "A",
            ttl: 60,
            records: ["192.0.2.20"],
          });
        }),
      );
      expect(initial.records).toEqual(["192.0.2.20"]);

      // Mutate the record out-of-band.
      const mutateResp = yield* route53.changeResourceRecordSets({
        HostedZoneId: zone.hostedZoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: normalizeName(recordName),
                Type: "A",
                TTL: 3600,
                ResourceRecords: [{ Value: "203.0.113.99" }],
              },
            },
          ],
        },
      });
      yield* waitForInSync(mutateResp.ChangeInfo.Id);

      const drifted = yield* findRecord(zone.hostedZoneId, recordName, "A");
      expect(drifted?.TTL).toEqual(3600);
      expect(drifted?.ResourceRecords?.[0]?.Value).toEqual("203.0.113.99");

      // Re-deploy with the original desired props — reconciler should
      // overwrite the drifted record back to the canonical values.
      const reconciled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("DriftRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: recordName,
            type: "A",
            ttl: 60,
            records: ["192.0.2.20"],
          });
        }),
      );
      expect(reconciled.records).toEqual(["192.0.2.20"]);
      expect(reconciled.ttl).toEqual(60);

      yield* stack.destroy();
      yield* deleteTestHostedZone(zone.hostedZoneId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "reconcile re-creates a record that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* createTestHostedZone("recreate");
      const recordName = `recreate.${zone.domain}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("RecreateRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: recordName,
            type: "TXT",
            ttl: 60,
            records: ['"hello"'],
          });
        }),
      );
      expect(initial.records).toEqual(['"hello"']);

      // Delete the record out-of-band.
      const deleteResp = yield* route53.changeResourceRecordSets({
        HostedZoneId: zone.hostedZoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: "DELETE",
              ResourceRecordSet: {
                Name: normalizeName(recordName),
                Type: "TXT",
                TTL: 60,
                ResourceRecords: [{ Value: '"hello"' }],
              },
            },
          ],
        },
      });
      yield* waitForInSync(deleteResp.ChangeInfo.Id);

      const gone = yield* findRecord(zone.hostedZoneId, recordName, "TXT");
      expect(gone).toBeUndefined();

      // Re-deploy — reconciler must recreate the record from desired.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("RecreateRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: recordName,
            type: "TXT",
            ttl: 60,
            records: ['"hello"'],
          });
        }),
      );
      expect(recreated.records).toEqual(['"hello"']);

      const observed = yield* findRecord(zone.hostedZoneId, recordName, "TXT");
      expect(observed).toBeDefined();

      yield* stack.destroy();
      yield* deleteTestHostedZone(zone.hostedZoneId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "changing record type triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* createTestHostedZone("replace");
      const recordName = `replace.${zone.domain}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("ReplaceRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: recordName,
            type: "A",
            ttl: 60,
            records: ["192.0.2.30"],
          });
        }),
      );
      expect(a.type).toEqual("A");

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("ReplaceRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: recordName,
            type: "TXT",
            ttl: 60,
            records: ['"replaced"'],
          });
        }),
      );
      expect(b.type).toEqual("TXT");
      expect(b.records).toEqual(['"replaced"']);

      // Old A record should be gone after replace.
      const oldA = yield* findRecord(zone.hostedZoneId, recordName, "A");
      expect(oldA).toBeUndefined();

      yield* stack.destroy();
      yield* deleteTestHostedZone(zone.hostedZoneId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "changing record name triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* createTestHostedZone("rename");
      const nameA = `original.${zone.domain}`;
      const nameB = `renamed.${zone.domain}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("RenameRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: nameA,
            type: "A",
            ttl: 60,
            records: ["192.0.2.40"],
          });
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("RenameRecord", {
            hostedZoneId: zone.hostedZoneId,
            name: nameB,
            type: "A",
            ttl: 60,
            records: ["192.0.2.40"],
          });
        }),
      );

      // Old name should be cleaned up after replace.
      const oldRecord = yield* findRecord(zone.hostedZoneId, nameA, "A");
      expect(oldRecord).toBeUndefined();

      // New name should exist.
      const newRecord = yield* findRecord(zone.hostedZoneId, nameB, "A");
      expect(newRecord).toBeDefined();
      expect(newRecord?.ResourceRecords?.[0]?.Value).toEqual("192.0.2.40");

      yield* stack.destroy();
      yield* deleteTestHostedZone(zone.hostedZoneId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "concurrent records sharing a hosted zone all converge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* createTestHostedZone("concurrent");

      // Deploy three records into the same zone in one pass. The
      // reconciler must tolerate `PriorRequestNotComplete` from the
      // shared-zone serialization that Route53 enforces.
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* Record("ConcurrentA", {
            hostedZoneId: zone.hostedZoneId,
            name: `a.${zone.domain}`,
            type: "A",
            ttl: 60,
            records: ["192.0.2.50"],
          });
          const b = yield* Record("ConcurrentB", {
            hostedZoneId: zone.hostedZoneId,
            name: `b.${zone.domain}`,
            type: "A",
            ttl: 60,
            records: ["192.0.2.51"],
          });
          const c = yield* Record("ConcurrentC", {
            hostedZoneId: zone.hostedZoneId,
            name: `c.${zone.domain}`,
            type: "TXT",
            ttl: 60,
            records: ['"c"'],
          });
          return { a, b, c };
        }),
      );

      expect(result.a.records).toEqual(["192.0.2.50"]);
      expect(result.b.records).toEqual(["192.0.2.51"]);
      expect(result.c.records).toEqual(['"c"']);

      // Now remove one of the three; the destroy of A must coexist with
      // B and C still in place.
      yield* stack.deploy(
        Effect.gen(function* () {
          const b = yield* Record("ConcurrentB", {
            hostedZoneId: zone.hostedZoneId,
            name: `b.${zone.domain}`,
            type: "A",
            ttl: 60,
            records: ["192.0.2.51"],
          });
          const c = yield* Record("ConcurrentC", {
            hostedZoneId: zone.hostedZoneId,
            name: `c.${zone.domain}`,
            type: "TXT",
            ttl: 60,
            records: ['"c"'],
          });
          return { b, c };
        }),
      );

      const a = yield* findRecord(zone.hostedZoneId, `a.${zone.domain}`, "A");
      expect(a).toBeUndefined();

      const b = yield* findRecord(zone.hostedZoneId, `b.${zone.domain}`, "A");
      expect(b).toBeDefined();

      yield* stack.destroy();
      yield* deleteTestHostedZone(zone.hostedZoneId);
    }),
  { timeout: 360_000 },
);

test.provider(
  "destroying an already-deleted record is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* createTestHostedZone("doubledestroy");
      const recordName = `dd.${zone.domain}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Record("DoubleDestroy", {
            hostedZoneId: zone.hostedZoneId,
            name: recordName,
            type: "A",
            ttl: 60,
            records: ["192.0.2.60"],
          });
        }),
      );

      // Delete the record out-of-band, then ask the engine to destroy.
      const deleteResp = yield* route53.changeResourceRecordSets({
        HostedZoneId: zone.hostedZoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: "DELETE",
              ResourceRecordSet: {
                Name: normalizeName(recordName),
                Type: "A",
                TTL: 60,
                ResourceRecords: [{ Value: "192.0.2.60" }],
              },
            },
          ],
        },
      });
      yield* waitForInSync(deleteResp.ChangeInfo.Id);

      // The engine's delete must finish cleanly.
      yield* stack.destroy();

      yield* deleteTestHostedZone(zone.hostedZoneId);
    }),
  { timeout: 240_000 },
);

void RecordStillExists;
