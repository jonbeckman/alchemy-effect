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

const getToken = (id: string) =>
  AxiomSdk.getAPIToken({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "redeploy with same props is a no-op (no rotation)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-token-${suffix}`;
      const tokenName = `alchemy-test-token-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.ApiToken("T", {
            name: tokenName,
            description: "stable",
            datasetCapabilities: { [ds]: { ingest: ["create"] } },
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.ApiToken("T", {
            name: tokenName,
            description: "stable",
            datasetCapabilities: { [ds]: { ingest: ["create"] } },
          });
        }),
      );
      expect(second.id).toEqual(initial.id);

      yield* stack.destroy();
      const after = yield* getToken(initial.id);
      expect(after).toBeUndefined();
    }).pipe(logLevel),
);

test.provider(
  "changing description triggers replace (token rotation)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-token-rep-${suffix}`;
      const tokenName = `alchemy-test-token-rep-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.ApiToken("T", {
            name: tokenName,
            description: "original",
            datasetCapabilities: { [ds]: { ingest: ["create"] } },
          });
        }),
      );

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.ApiToken("T", {
            name: tokenName,
            description: "rotated",
            datasetCapabilities: { [ds]: { ingest: ["create"] } },
          });
        }),
      );
      expect(b.id).not.toEqual(a.id);

      // Old token is gone.
      const oldGone = yield* getToken(a.id);
      expect(oldGone).toBeUndefined();
      const newLive = yield* getToken(b.id);
      expect(newLive?.id).toEqual(b.id);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted token is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const ds = `alchemy-test-token-dd-${suffix}`;
      const tokenName = `alchemy-test-token-dd-${suffix}`;

      const tok = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("DS", { name: ds });
          return yield* Axiom.ApiToken("T", {
            name: tokenName,
            datasetCapabilities: { [ds]: { ingest: ["create"] } },
          });
        }),
      );

      yield* AxiomSdk.deleteAPIToken({ id: tok.id });
      yield* stack.destroy();
    }).pipe(logLevel),
);
