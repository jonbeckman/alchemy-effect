import { adopt } from "@/AdoptPolicy";
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Gateway } from "./gateway.ts";
import AiGatewayTestWorker from "./worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete ai gateway with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const gateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("DefaultGateway", {
          id: "alchemy-test-ai-gateway-default",
        });
      }),
    );

    expect(gateway.gatewayId).toEqual("alchemy-test-ai-gateway-default");
    expect(gateway.cacheInvalidateOnUpdate).toEqual(false);
    expect(gateway.cacheTtl).toEqual(null);
    expect(gateway.collectLogs).toEqual(true);
    expect(gateway.rateLimitingInterval).toEqual(null);
    expect(gateway.rateLimitingLimit).toEqual(null);
    expect(gateway.rateLimitingTechnique).toEqual("fixed");

    const actualGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: gateway.gatewayId,
    });
    expect(actualGateway.id).toEqual(gateway.gatewayId);

    yield* stack.destroy();

    yield* waitForGatewayToBeDeleted(gateway.gatewayId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete ai gateway", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const gateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("TestGateway", {
          id: "alchemy-test-ai-gateway",
          cacheTtl: 60,
          collectLogs: true,
          rateLimitingInterval: 60,
          rateLimitingLimit: 100,
          rateLimitingTechnique: "fixed",
        });
      }),
    );

    const actualGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: gateway.gatewayId,
    });
    expect(actualGateway.id).toEqual(gateway.gatewayId);
    expect(actualGateway.cacheTtl).toEqual(60);
    expect(actualGateway.rateLimitingLimit).toEqual(100);

    const updatedGateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("TestGateway", {
          id: "alchemy-test-ai-gateway",
          cacheTtl: 120,
          collectLogs: true,
          rateLimitingInterval: 120,
          rateLimitingLimit: 200,
          rateLimitingTechnique: "sliding",
        });
      }),
    );

    const actualUpdatedGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: updatedGateway.gatewayId,
    });
    expect(actualUpdatedGateway.cacheTtl).toEqual(120);
    expect(actualUpdatedGateway.rateLimitingInterval).toEqual(120);
    expect(actualUpdatedGateway.rateLimitingLimit).toEqual(200);
    expect(actualUpdatedGateway.rateLimitingTechnique).toEqual("sliding");

    yield* stack.destroy();

    yield* waitForGatewayToBeDeleted(gateway.gatewayId, accountId);
  }).pipe(logLevel),
);

// Engine-level adoption: AI Gateways have no ownership signal (Cloudflare
// doesn't expose tags on AI Gateways), so a name match in `read` is treated
// as silent adoption.
test.provider(
  "existing ai gateway (matching id) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const gatewayId = `alchemy-test-aigw-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy normally so a real AI Gateway exists.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("AdoptableGateway", {
            id: gatewayId,
          });
        }),
      );
      expect(initial.gatewayId).toEqual(gatewayId);

      // Phase 2: wipe local state — the gateway stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableGateway",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which fetches the gateway by id and returns plain
      // attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("AdoptableGateway", {
            id: gatewayId,
          });
        }),
      );

      expect(adopted.gatewayId).toEqual(gatewayId);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableGateway",
        });
      }).pipe(Effect.provide(stack.state));

      expect(persisted?.attr).toMatchObject({ gatewayId });

      yield* stack.destroy();
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      yield* stack.destroy();

      const gatewayId = `alchemy-test-aigw-noop-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("NoopGateway", {
            id: gatewayId,
            cacheTtl: 90,
            collectLogs: true,
            rateLimitingInterval: 60,
            rateLimitingLimit: 50,
            rateLimitingTechnique: "fixed",
          });
        }),
      );

      // Re-deploy with identical props — must converge to the same gateway
      // without replacing it. internalId is server-assigned and stable
      // across mutations on the same gateway, so we use it as the proof
      // that no replacement happened.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("NoopGateway", {
            id: gatewayId,
            cacheTtl: 90,
            collectLogs: true,
            rateLimitingInterval: 60,
            rateLimitingLimit: 50,
            rateLimitingTechnique: "fixed",
          });
        }),
      );
      expect(second.gatewayId).toEqual(initial.gatewayId);
      expect(second.internalId).toEqual(initial.internalId);
      expect(second.cacheTtl).toEqual(90);
      expect(second.rateLimitingLimit).toEqual(50);

      yield* stack.destroy();
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets settings mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      yield* stack.destroy();

      const gatewayId = `alchemy-test-aigw-drift-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("DriftGateway", {
            id: gatewayId,
            cacheTtl: 60,
            rateLimitingInterval: 30,
            rateLimitingLimit: 100,
            rateLimitingTechnique: "fixed",
            authentication: false,
          });
        }),
      );
      expect(initial.cacheTtl).toEqual(60);
      expect(initial.rateLimitingLimit).toEqual(100);
      expect(initial.authentication).toEqual(false);

      // Mutate the gateway out-of-band via the raw distilled client.
      yield* aiGateway.updateAiGateway({
        accountId,
        id: gatewayId,
        cacheInvalidateOnUpdate: false,
        cacheTtl: 999,
        collectLogs: true,
        rateLimitingInterval: 5,
        rateLimitingLimit: 7,
        rateLimitingTechnique: "sliding",
        authentication: true,
      });
      const drifted = yield* aiGateway.getAiGateway({
        accountId,
        id: gatewayId,
      });
      expect(drifted.cacheTtl).toEqual(999);
      expect(drifted.rateLimitingLimit).toEqual(7);
      expect(drifted.authentication).toEqual(true);

      // Re-deploy with original desired props — reconcile should reset
      // the drifted settings back to what we asked for.
      const reconciled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("DriftGateway", {
            id: gatewayId,
            cacheTtl: 60,
            rateLimitingInterval: 30,
            rateLimitingLimit: 100,
            rateLimitingTechnique: "fixed",
            authentication: false,
          });
        }),
      );
      expect(reconciled.cacheTtl).toEqual(60);
      expect(reconciled.rateLimitingInterval).toEqual(30);
      expect(reconciled.rateLimitingLimit).toEqual(100);
      expect(reconciled.rateLimitingTechnique).toEqual("fixed");
      expect(reconciled.authentication).toEqual(false);
      expect(reconciled.internalId).toEqual(initial.internalId);

      yield* stack.destroy();
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a gateway that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      yield* stack.destroy();

      const gatewayId = `alchemy-test-aigw-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("RecreateGateway", {
            id: gatewayId,
            cacheTtl: 60,
          });
        }),
      );

      // Delete the gateway out-of-band.
      yield* aiGateway.deleteAiGateway({ accountId, id: gatewayId });
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);

      // Re-deploy must converge by re-creating the gateway.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("RecreateGateway", {
            id: gatewayId,
            cacheTtl: 60,
          });
        }),
      );
      expect(recreated.gatewayId).toEqual(gatewayId);
      expect(recreated.cacheTtl).toEqual(60);

      const live = yield* aiGateway.getAiGateway({
        accountId,
        id: gatewayId,
      });
      expect(live.id).toEqual(gatewayId);

      yield* stack.destroy();
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "changing id triggers replace",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const idA = `alchemy-test-aigw-replace-a-${suffix}`;
      const idB = `alchemy-test-aigw-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("RenameGateway", { id: idA });
        }),
      );
      expect(a.gatewayId).toEqual(idA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("RenameGateway", { id: idB });
        }),
      );
      expect(b.gatewayId).toEqual(idB);
      expect(b.internalId).not.toEqual(a.internalId);

      // Old gateway must be deleted after replacement.
      yield* waitForGatewayToBeDeleted(idA, accountId);

      yield* stack.destroy();
      yield* waitForGatewayToBeDeleted(idB, accountId);
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted gateway is a no-op",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      yield* stack.destroy();

      const gatewayId = `alchemy-test-aigw-doubledel-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGateway("DoubleDestroyGateway", {
            id: gatewayId,
          });
        }),
      );

      // Delete out-of-band, then ask the engine to destroy.
      // Provider's `delete` must catch GatewayNotFound and complete cleanly.
      yield* aiGateway.deleteAiGateway({ accountId, id: gatewayId });
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a foreign gateway",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      yield* stack.destroy();

      const gatewayId = `alchemy-test-aigw-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: create a gateway out-of-band so it isn't tracked by the
      // engine. AI Gateways have no ownership tags, so any existing gateway
      // is treated as "foreign".
      yield* aiGateway.createAiGateway({
        accountId,
        id: gatewayId,
        cacheInvalidateOnUpdate: false,
        cacheTtl: 0,
        collectLogs: true,
        rateLimitingInterval: 0,
        rateLimitingLimit: 0,
        rateLimitingTechnique: "fixed",
      });

      // Phase 2: deploy with `adopt(true)` — engine takes over via `read`
      // and reconciles to our desired settings.
      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.AiGateway("ForeignGateway", {
              id: gatewayId,
              cacheTtl: 120,
              rateLimitingInterval: 60,
              rateLimitingLimit: 25,
              rateLimitingTechnique: "sliding",
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.gatewayId).toEqual(gatewayId);
      expect(takenOver.cacheTtl).toEqual(120);
      expect(takenOver.rateLimitingLimit).toEqual(25);
      expect(takenOver.rateLimitingTechnique).toEqual("sliding");

      yield* stack.destroy();
      yield* waitForGatewayToBeDeleted(gatewayId, accountId);
    }).pipe(logLevel),
);

const waitForGatewayToBeDeleted = Effect.fn(function* (
  gatewayId: string,
  accountId: string,
) {
  yield* aiGateway
    .getAiGateway({
      accountId,
      id: gatewayId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new GatewayStillExists())),
      Effect.retry({
        while: (e): e is GatewayStillExists => e instanceof GatewayStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("GatewayNotFound", () => Effect.void),
    );
});

class GatewayStillExists extends Data.TaggedError("GatewayStillExists") {}

const Stack = Alchemy.Stack(
  "AiGatewayBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const gateway = yield* Gateway;
    const worker = yield* AiGatewayTestWorker;
    return {
      gatewayId: gateway.gatewayId,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker can call AiGateway binding (effect-native getUrl)",
  Effect.gen(function* () {
    const out = yield* stack;
    const workerUrl = out.url;
    expect(workerUrl).toBeTypeOf("string");
    expect(out.gatewayId).toBe("alchemy-test-ai-gateway-binding");

    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${workerUrl}/url`).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { url: string };
    // The runtime gateway exposes a stable account-scoped URL like
    // https://gateway.ai.cloudflare.com/v1/<accountId>/<gatewayId>
    expect(body.url).toContain(out.gatewayId);
    expect(body.url).toContain("gateway.ai.cloudflare.com");
  }).pipe(logLevel),
  { timeout: 180_000 },
);
