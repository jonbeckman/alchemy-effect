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

const getVF = (id: string) =>
  AxiomSdk.getVirtualField({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "redeploy with same props is a no-op (idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-vf-${suffix}`;
      const vfName = `vf_${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: vfName,
            description: "stable",
            expression: "1 + 1",
            type: "number",
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: vfName,
            description: "stable",
            expression: "1 + 1",
            type: "number",
          });
        }),
      );
      expect(second.id).toEqual(initial.id);

      yield* stack.destroy();
      const after = yield* getVF(initial.id);
      expect(after).toBeUndefined();
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets expression mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-vf-drift-${suffix}`;
      const vfName = `vf_drift_${suffix}`;

      const vf = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: vfName,
            description: "managed",
            expression: "status",
            type: "number",
          });
        }),
      );

      yield* AxiomSdk.updateVirtualField({
        id: vf.id,
        dataset: ds,
        name: vfName,
        description: "drifted",
        expression: "999",
        type: "number",
      });

      const drifted = yield* getVF(vf.id);
      expect(drifted?.expression).toEqual("999");

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: vfName,
            description: "managed",
            expression: "status",
            type: "number",
          });
        }),
      );

      const reconverged = yield* getVF(vf.id);
      expect(reconverged?.expression).toEqual("status");
      expect(reconverged?.description).toContain("managed");
      expect(reconverged?.description).toContain("[alchemy:");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a virtual field deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-vf-recreate-${suffix}`;
      const vfName = `vf_recreate_${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: vfName,
            expression: "1",
            type: "number",
          });
        }),
      );

      yield* AxiomSdk.deleteVirtualField({ id: initial.id });
      const gone = yield* getVF(initial.id);
      expect(gone).toBeUndefined();

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: vfName,
            expression: "1",
            type: "number",
          });
        }),
      );
      const live = yield* getVF(recreated.id);
      expect(live?.name).toEqual(vfName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing name updates in place (not a replace)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-vf-rename-${suffix}`;
      const nameA = `vf_a_${suffix}`;
      const nameB = `vf_b_${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: nameA,
            expression: "1",
            type: "number",
          });
        }),
      );

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: nameB,
            expression: "1",
            type: "number",
          });
        }),
      );
      expect(b.id).toEqual(a.id);
      expect(b.name).toEqual(nameB);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted virtual field is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-vf-doubledel-${suffix}`;
      const vfName = `vf_dd_${suffix}`;

      const vf = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.VirtualField("VF", {
            dataset: ds,
            name: vfName,
            expression: "1",
            type: "number",
          });
        }),
      );

      yield* AxiomSdk.deleteVirtualField({ id: vf.id });
      yield* stack.destroy();
    }).pipe(logLevel),
);
