import * as Axiom from "@/Axiom";
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

const getAnnotation = (id: string) =>
  AxiomSdk.getAnnotation({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "redeploy with same props is a no-op (idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-ann-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "v1",
            description: "stable",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "v1",
            description: "stable",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );
      expect(second.id).toEqual(initial.id);

      yield* stack.destroy();
      const after = yield* getAnnotation(initial.id!);
      expect(after).toBeUndefined();
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets title mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-ann-drift-${suffix}`;

      const ann = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "managed",
            description: "managed",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );

      yield* AxiomSdk.updateAnnotation({
        id: ann.id!,
        title: "drifted",
        description: "drifted",
        type: "deploy",
        datasets: [ds],
        time: "2026-01-01T00:00:00Z",
      });

      const drifted = yield* getAnnotation(ann.id!);
      expect(drifted?.title).toEqual("drifted");

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "managed",
            description: "managed",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );

      const reconverged = yield* getAnnotation(ann.id!);
      expect(reconverged?.title).toEqual("managed");
      expect(reconverged?.description).toContain("[alchemy:");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates an annotation deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-ann-recreate-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "first",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );

      yield* AxiomSdk.deleteAnnotation({ id: initial.id! });
      const gone = yield* getAnnotation(initial.id!);
      expect(gone).toBeUndefined();

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "first",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );
      const live = yield* getAnnotation(recreated.id!);
      expect(live?.title).toEqual("first");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing title updates in place (not a replace)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-ann-rename-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "title-a",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            title: "title-b",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );
      expect(b.id).toEqual(a.id);
      expect(b.title).toEqual("title-b");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted annotation is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-ann-doubledel-${suffix}`;

      const ann = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.Annotation("A", {
            type: "deploy",
            datasets: [ds],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );

      yield* AxiomSdk.deleteAnnotation({ id: ann.id! });
      yield* stack.destroy();
    }).pipe(logLevel),
);
