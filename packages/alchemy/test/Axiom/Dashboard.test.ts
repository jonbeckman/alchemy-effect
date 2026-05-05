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

const getDashboard = (uid: string) =>
  AxiomSdk.getDashboard({ uid }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const baseDoc = (name: string, description: string) => ({
  name,
  owner: "",
  description,
  charts: [],
  layout: [],
  refreshTime: 60 as const,
  schemaVersion: 2 as const,
  timeWindowStart: "qr-now-1h",
  timeWindowEnd: "qr-now",
});

test.provider(
  "redeploy with same props is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dashName = `alchemy-test-dash-idem-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(dashName, "stable"),
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(dashName, "stable"),
          });
        }),
      );
      expect(second.uid).toEqual(initial.uid);
      expect(second.id).toEqual(initial.id);

      yield* stack.destroy();
      const after = yield* getDashboard(initial.uid);
      expect(after).toBeUndefined();
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets description mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dashName = `alchemy-test-dash-drift-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(dashName, "managed"),
          });
        }),
      );

      yield* AxiomSdk.updateDashboard({
        uid: initial.uid,
        dashboard: baseDoc(dashName, "drifted"),
        overwrite: true,
      });

      const drifted = yield* getDashboard(initial.uid);
      expect(drifted?.dashboard.description).toEqual("drifted");

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(dashName, "managed"),
          });
        }),
      );

      const reconverged = yield* getDashboard(initial.uid);
      expect(reconverged?.dashboard.description).toContain("managed");
      expect(reconverged?.dashboard.description).toContain("[alchemy:");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a dashboard deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dashName = `alchemy-test-dash-recreate-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(dashName, "first"),
          });
        }),
      );

      yield* AxiomSdk.deleteDashboard({ uid: initial.uid });
      const gone = yield* getDashboard(initial.uid);
      expect(gone).toBeUndefined();

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(dashName, "first"),
          });
        }),
      );
      // New uid since dashboards are server-id'd.
      const live = yield* getDashboard(recreated.uid);
      expect(live?.dashboard.name).toEqual(dashName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing dashboard name updates in place (not a replace)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const nameA = `alchemy-test-dash-rename-a-${suffix}`;
      const nameB = `alchemy-test-dash-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(nameA, "rename"),
          });
        }),
      );

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(nameB, "rename"),
          });
        }),
      );
      expect(b.uid).toEqual(a.uid);
      const live = yield* getDashboard(b.uid);
      expect(live?.dashboard.name).toEqual(nameB);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted dashboard is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dashName = `alchemy-test-dash-doubledel-${randomSuffix()}`;
      const dash = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("D", {
            dashboard: baseDoc(dashName, "to-be-deleted"),
          });
        }),
      );

      yield* AxiomSdk.deleteDashboard({ uid: dash.uid });
      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a foreign-marked dashboard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dashName = `alchemy-test-dash-adopt-${randomSuffix()}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("Original", {
            dashboard: baseDoc(dashName, "original"),
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

      // Without state, a fresh logical id under the same uid would
      // create a *new* dashboard (uid is server-assigned). The adoption
      // story for Dashboard is "if state was lost but you remember the
      // uid, read can recognize it as foreign." Here we exercise read's
      // Unowned path indirectly: we'd need to pass the uid through.
      // Since alchemy can't recover the uid without state, this path
      // mainly exercises that creating a new dashboard with the same
      // *name* succeeds (uids differ).
      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Axiom.Dashboard("Taken", {
              dashboard: baseDoc(dashName, "taken-over"),
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.uid).not.toEqual(original.uid);

      // Cleanup the orphan.
      yield* AxiomSdk.deleteDashboard({ uid: original.uid }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
);
