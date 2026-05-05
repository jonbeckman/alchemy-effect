import { adopt } from "@/AdoptPolicy";
import * as Axiom from "@/Axiom";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as AxiomSdk from "@distilled.cloud/axiom";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

/** Probe Axiom for a dataset; resolve to undefined on NotFound. */
const getDataset = (datasetId: string) =>
  AxiomSdk.getDataset({ dataset_id: datasetId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const assertDatasetDeleted = Effect.fn(function* (datasetId: string) {
  const found = yield* getDataset(datasetId);
  expect(found).toBeUndefined();
});

test.provider(
  "create and delete dataset with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const datasetName = `alchemy-test-default-${randomSuffix()}`;

      const dataset = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("DefaultDataset", {
            name: datasetName,
            description: "default-test",
          });
        }),
      );

      expect(dataset.name).toEqual(datasetName);
      expect(dataset.id).toBeDefined();
      expect(dataset.description).toEqual("default-test");
      expect(dataset.kind).toBeDefined();
      expect(dataset.otelTracesEndpoint).toContain("/v1/traces");

      const observed = yield* getDataset(dataset.id);
      expect(observed?.name).toEqual(datasetName);

      yield* stack.destroy();
      yield* assertDatasetDeleted(datasetName);
    }).pipe(logLevel),
);

test.provider(
  "create, update, delete dataset (mutable description + retention)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const datasetName = `alchemy-test-update-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("UpdateDataset", {
            name: datasetName,
            description: "initial",
            retentionDays: 30,
            useRetentionPeriod: true,
          });
        }),
      );
      expect(initial.description).toEqual("initial");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("UpdateDataset", {
            name: datasetName,
            description: "updated copy",
            retentionDays: 7,
            useRetentionPeriod: true,
          });
        }),
      );
      expect(updated.id).toEqual(initial.id);
      expect(updated.description).toEqual("updated copy");

      const live = yield* getDataset(datasetName);
      expect(live?.retentionDays).toEqual(7);
      // Cloud description still carries the alchemy ownership marker.
      expect(live?.description).toContain("[alchemy:");
      expect(live?.description).toContain("updated copy");

      yield* stack.destroy();
      yield* assertDatasetDeleted(datasetName);
    }).pipe(logLevel),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const datasetName = `alchemy-test-idempotent-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("IdempotentDataset", {
            name: datasetName,
            description: "stable",
            retentionDays: 14,
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("IdempotentDataset", {
            name: datasetName,
            description: "stable",
            retentionDays: 14,
          });
        }),
      );

      expect(second.id).toEqual(initial.id);
      expect(second.created).toEqual(initial.created);
      expect(second.description).toEqual("stable");

      const live = yield* getDataset(datasetName);
      expect(live?.retentionDays).toEqual(14);

      yield* stack.destroy();
      yield* assertDatasetDeleted(datasetName);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets description / retention mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const datasetName = `alchemy-test-drift-${randomSuffix()}`;

      const dataset = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("DriftDataset", {
            name: datasetName,
            description: "managed",
            retentionDays: 30,
            useRetentionPeriod: true,
          });
        }),
      );

      // Mutate out-of-band: bypass alchemy and stomp on description +
      // retentionDays directly via the raw Axiom API. The marker that
      // `reconcile` appended is intentionally dropped here so we exercise
      // the marker-restoration path too.
      yield* AxiomSdk.updateDataset({
        dataset_id: dataset.id,
        description: "drifted-out-of-band",
        retentionDays: 90,
        useRetentionPeriod: true,
      });

      const drifted = yield* getDataset(datasetName);
      expect(drifted?.description).toEqual("drifted-out-of-band");
      expect(drifted?.retentionDays).toEqual(90);

      // Re-deploy with the same desired props — reconcile must observe
      // the cloud (not olds) and converge it back.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("DriftDataset", {
            name: datasetName,
            description: "managed",
            retentionDays: 30,
            useRetentionPeriod: true,
          });
        }),
      );
      expect(redeployed.id).toEqual(dataset.id);

      const reconverged = yield* getDataset(datasetName);
      expect(reconverged?.retentionDays).toEqual(30);
      expect(reconverged?.description).toContain("managed");
      expect(reconverged?.description).toContain("[alchemy:");

      yield* stack.destroy();
      yield* assertDatasetDeleted(datasetName);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a dataset that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const datasetName = `alchemy-test-recreate-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("RecreateDataset", {
            name: datasetName,
            description: "first",
          });
        }),
      );

      // Delete the dataset out-of-band — alchemy state still believes
      // the dataset exists at this id. Reconcile must observe NotFound
      // and re-create.
      yield* AxiomSdk.deleteDataset({ dataset_id: initial.id });
      yield* assertDatasetDeleted(datasetName);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("RecreateDataset", {
            name: datasetName,
            description: "first",
          });
        }),
      );
      expect(recreated.name).toEqual(datasetName);
      expect(recreated.description).toEqual("first");

      const live = yield* getDataset(datasetName);
      expect(live?.name).toEqual(datasetName);

      yield* stack.destroy();
      yield* assertDatasetDeleted(datasetName);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing name triggers replace; old dataset is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const nameA = `alchemy-test-rename-a-${suffix}`;
      const nameB = `alchemy-test-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("RenameDataset", {
            name: nameA,
            description: "rename-source",
          });
        }),
      );
      expect(a.name).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("RenameDataset", {
            name: nameB,
            description: "rename-source",
          });
        }),
      );
      expect(b.name).toEqual(nameB);
      expect(b.id).not.toEqual(a.id);

      yield* assertDatasetDeleted(nameA);

      yield* stack.destroy();
      yield* assertDatasetDeleted(nameB);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted dataset is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const datasetName = `alchemy-test-doubledel-${randomSuffix()}`;

      const dataset = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("DoubleDestroyDataset", {
            name: datasetName,
            description: "to-be-deleted",
          });
        }),
      );

      // Delete out-of-band, then ask the engine to destroy it.
      // Provider's `delete` must catch NotFound and complete cleanly.
      yield* AxiomSdk.deleteDataset({ dataset_id: dataset.id });
      yield* assertDatasetDeleted(datasetName);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a foreign dataset by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const datasetName = `alchemy-test-adopt-${randomSuffix()}`;

      // First create via alchemy under one logical id.
      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("Original", {
            name: datasetName,
            description: "original",
          });
        }),
      );

      // Wipe state but leave the dataset alive — same as cold-start
      // from a foreign-tagged cloud resource.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      // A different logical id pointing at the same cloud name. Without
      // `adopt(true)` the engine refuses (foreign marker). With it, we
      // take over and re-tag with our own marker.
      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Axiom.Dataset("Taken", {
              name: datasetName,
              description: "taken-over",
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.name).toEqual(datasetName);
      expect(takenOver.id).toEqual(original.id);

      // Marker re-pointed at the new logical id so subsequent runs route
      // through silent adoption.
      const live = yield* getDataset(datasetName);
      expect(live?.description).toContain("id=Taken");

      yield* stack.destroy();
      yield* assertDatasetDeleted(datasetName);
    }).pipe(logLevel),
);
