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

const getView = (id: string) =>
  AxiomSdk.getView({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const assertViewDeleted = Effect.fn(function* (id: string) {
  const found = yield* getView(id);
  expect(found).toBeUndefined();
});

const datasetName = (suffix: string) => `alchemy-test-view-${suffix}`;

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const name = `alchemy-test-view-idem-${suffix}`;
      const ds = datasetName(suffix);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name,
            description: "stable",
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name,
            description: "stable",
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );
      expect(second.id).toEqual(initial.id);

      yield* stack.destroy();
      yield* assertViewDeleted(name);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets description / aplQuery mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const name = `alchemy-test-view-drift-${suffix}`;
      const ds = datasetName(suffix);

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name,
            description: "managed",
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );

      yield* AxiomSdk.updateView({
        id: name,
        name,
        description: "drifted",
        datasets: [ds],
        aplQuery: `['${ds}'] | take 1`,
      });

      const drifted = yield* getView(name);
      expect(drifted?.description).toEqual("drifted");

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name,
            description: "managed",
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );

      const reconverged = yield* getView(name);
      expect(reconverged?.aplQuery).toEqual(`['${ds}']`);
      expect(reconverged?.description).toContain("managed");
      expect(reconverged?.description).toContain("[alchemy:");

      yield* stack.destroy();
      yield* assertViewDeleted(name);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a view that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const name = `alchemy-test-view-recreate-${suffix}`;
      const ds = datasetName(suffix);

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name,
            description: "first",
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );

      yield* AxiomSdk.deleteView({ id: name });
      yield* assertViewDeleted(name);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name,
            description: "first",
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );
      expect(recreated.name).toEqual(name);

      const live = yield* getView(name);
      expect(live?.name).toEqual(name);

      yield* stack.destroy();
      yield* assertViewDeleted(name);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing name triggers replace; old view is gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const nameA = `alchemy-test-view-rename-a-${suffix}`;
      const nameB = `alchemy-test-view-rename-b-${suffix}`;
      const ds = datasetName(suffix);

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name: nameA,
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name: nameB,
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );

      yield* assertViewDeleted(nameA);
      const live = yield* getView(nameB);
      expect(live?.name).toEqual(nameB);

      yield* stack.destroy();
      yield* assertViewDeleted(nameB);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted view is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const name = `alchemy-test-view-doubledel-${suffix}`;
      const ds = datasetName(suffix);

      const view = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("V", {
            name,
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
        }),
      );

      yield* AxiomSdk.deleteView({ id: view.id });
      yield* assertViewDeleted(name);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a foreign view by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const name = `alchemy-test-view-adopt-${suffix}`;
      const ds = datasetName(suffix);

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.View("Original", {
            name,
            description: "original",
            datasets: [ds],
            aplQuery: `['${ds}']`,
          });
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
            yield* Axiom.Dataset("DS", { name: ds });
            return yield* Axiom.View("Taken", {
              name,
              description: "taken-over",
              datasets: [ds],
              aplQuery: `['${ds}']`,
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.name).toEqual(original.name);

      const live = yield* getView(name);
      expect(live?.description).toContain("id=Taken");

      yield* stack.destroy();
      yield* assertViewDeleted(name);
    }).pipe(logLevel),
);
