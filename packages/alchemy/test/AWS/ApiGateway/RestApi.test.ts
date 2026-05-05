import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

test.provider.skipIf(!runLive)("create and delete REST API", (stack) =>
  Effect.gen(function* () {
    const api = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AWS.ApiGateway.RestApi("AgRestApiLifecycle", {
          endpointConfiguration: { types: ["REGIONAL"] },
        });
      }),
    );

    expect(api.restApiId).toBeDefined();
    expect(api.rootResourceId).toBeDefined();

    const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
    expect(remote.id).toEqual(api.restApiId);

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!runLive)(
  "binary media types update applies via patch",
  (stack) =>
    Effect.gen(function* () {
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinary", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );

      expect(api.binaryMediaTypes?.includes("application/octet-stream")).toBe(
        true,
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinary", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream", "image/png"],
          });
        }),
      );

      const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(remote.binaryMediaTypes?.includes("image/png")).toBe(true);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "binary media types removal applies via patch",
  (stack) =>
    Effect.gen(function* () {
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinaryRemoval", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream", "image/png"],
          });
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinaryRemoval", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["image/png"],
          });
        }),
      );

      const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(remote.binaryMediaTypes?.includes("image/png")).toBe(true);
      expect(
        remote.binaryMediaTypes?.includes("application/octet-stream"),
      ).toBe(false);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiIdempotent", {
            endpointConfiguration: { types: ["REGIONAL"] },
            description: "initial",
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );

      // Deploy again with identical props — reconcile must converge without
      // touching the API. We assert by id stability and by the patched
      // attributes still holding their original values.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiIdempotent", {
            endpointConfiguration: { types: ["REGIONAL"] },
            description: "initial",
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );
      expect(second.restApiId).toEqual(initial.restApiId);
      expect(second.description).toEqual("initial");

      const remote = yield* ag.getRestApi({ restApiId: initial.restApiId });
      expect(remote.description).toEqual("initial");
      expect(remote.binaryMediaTypes).toEqual(["application/octet-stream"]);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "reconcile resets attributes mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiDrift", {
            endpointConfiguration: { types: ["REGIONAL"] },
            description: "desired",
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );

      // Mutate the API out-of-band via the raw SDK.
      yield* ag.updateRestApi({
        restApiId: api.restApiId,
        patchOperations: [
          { op: "replace", path: "/description", value: "DRIFTED" },
          { op: "remove", path: "/binaryMediaTypes/application~1octet-stream" },
          { op: "add", path: "/binaryMediaTypes/text~1plain", value: "text/plain" },
        ],
      });
      const drifted = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(drifted.description).toEqual("DRIFTED");
      expect(drifted.binaryMediaTypes).toEqual(["text/plain"]);

      // Re-deploy with the same desired props — reconcile must reset the
      // drifted scalars back to the desired values.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiDrift", {
            endpointConfiguration: { types: ["REGIONAL"] },
            description: "desired",
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );
      expect(redeployed.restApiId).toEqual(api.restApiId);

      const restored = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(restored.description).toEqual("desired");
      expect(restored.binaryMediaTypes).toEqual(["application/octet-stream"]);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "reconcile resets policy mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const desiredPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "execute-api:Invoke",
            Resource: "*",
          },
        ],
      });

      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiPolicy", {
            endpointConfiguration: { types: ["REGIONAL"] },
            policy: desiredPolicy,
          });
        }),
      );

      const driftedPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: "*",
            Action: "execute-api:Invoke",
            Resource: "*",
          },
        ],
      });

      yield* ag.updateRestApi({
        restApiId: api.restApiId,
        patchOperations: [
          { op: "replace", path: "/policy", value: driftedPolicy },
        ],
      });

      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiPolicy", {
            endpointConfiguration: { types: ["REGIONAL"] },
            policy: desiredPolicy,
          });
        }),
      );
      expect(redeployed.restApiId).toEqual(api.restApiId);

      const restored = yield* ag.getRestApi({ restApiId: api.restApiId });
      // The cloud serialises policy with quoted/escaped variations — assert
      // by structural identity (Allow effect, our action) rather than by
      // string compare.
      expect(restored.policy).toBeDefined();
      expect(restored.policy).toContain("Allow");
      expect(restored.policy).toContain("execute-api:Invoke");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "reconcile re-creates a RestApi that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiRecreate", {
            endpointConfiguration: { types: ["REGIONAL"] },
            description: "initial",
          });
        }),
      );

      // Delete the API out of band. DeleteRestApi is throttled at 1 req
      // per 30s account-wide; the engine's retry layer rides this out.
      yield* ag.deleteRestApi({ restApiId: initial.restApiId });

      // Re-deploying must converge by re-creating. The reconciler observes
      // a NotFoundException on the cached id and falls through to create.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiRecreate", {
            endpointConfiguration: { types: ["REGIONAL"] },
            description: "initial",
          });
        }),
      );

      expect(recreated.restApiId).toBeDefined();
      expect(recreated.restApiId).not.toEqual(initial.restApiId);
      const remote = yield* ag.getRestApi({ restApiId: recreated.restApiId });
      expect(remote.id).toEqual(recreated.restApiId);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "destroying an already-deleted RestApi is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiDoubleDestroy", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
        }),
      );

      // Delete the API out of band, then ask the engine to destroy it.
      // Provider's `delete` must catch NotFoundException and complete cleanly.
      yield* ag.deleteRestApi({ restApiId: api.restApiId });

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "owned RestApi (matching alchemy tags) is silently adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiAdoptable", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
        }),
      );

      // Wipe state — RestApi stays in the cloud.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AgRestApiAdoptable",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiAdoptable", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
        }),
      );

      expect(adopted.restApiId).toEqual(initial.restApiId);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "foreign-tagged RestApi requires adopt(true) and gets re-tagged",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const apiName = `alchemy-test-restapi-takeover-${randomSuffix()}`;

      // Create a "foreign" API directly via the SDK with no alchemy tags.
      const created = yield* ag.createRestApi({
        name: apiName,
        endpointConfiguration: { types: ["REGIONAL"] },
        tags: { foreign: "yes" },
      });
      if (!created.id) throw new Error("createRestApi missing id");

      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* AWS.ApiGateway.RestApi("AgRestApiTakeover", {
              name: apiName,
              endpointConfiguration: { types: ["REGIONAL"] },
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.name).toEqual(apiName);
      expect(takenOver.restApiId).toEqual(created.id);

      // adopt(true) must re-tag the API with the internal alchemy tags so
      // subsequent deploys silently adopt.
      const remote = yield* ag.getRestApi({ restApiId: created.id });
      expect(remote.tags?.["alchemy::id"]).toEqual("AgRestApiTakeover");
      expect(remote.tags?.["alchemy::stage"]).toBeDefined();

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!runLive)(
  "stage settings re-converge after out-of-band drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { stage, api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgStageDriftApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgStageDriftMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment(
            "AgStageDriftDep",
            { restApi: api },
          );
          const stage = yield* AWS.ApiGateway.Stage("AgStageDrift", {
            restApi: api,
            stageName: "dev",
            deploymentId: deployment.deploymentId,
            tracingEnabled: true,
            variables: { K: "desired" },
          });
          return { stage, api };
        }),
      );

      // Drift the stage out-of-band: flip tracing off and rewrite a variable.
      yield* ag.updateStage({
        restApiId: api.restApiId,
        stageName: stage.stageName,
        patchOperations: [
          { op: "replace", path: "/tracingEnabled", value: "false" },
          { op: "replace", path: "/variables/K", value: "DRIFTED" },
        ],
      });

      const drifted = yield* ag.getStage({
        restApiId: api.restApiId,
        stageName: stage.stageName,
      });
      expect(drifted.tracingEnabled).toBe(false);
      expect(drifted.variables?.K).toEqual("DRIFTED");

      // Redeploy — reconcile must reset the stage back to the desired state.
      yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgStageDriftApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgStageDriftMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment(
            "AgStageDriftDep",
            { restApi: api },
          );
          yield* AWS.ApiGateway.Stage("AgStageDrift", {
            restApi: api,
            stageName: "dev",
            deploymentId: deployment.deploymentId,
            tracingEnabled: true,
            variables: { K: "desired" },
          });
          return undefined;
        }),
      );

      const restored = yield* ag.getStage({
        restApiId: api.restApiId,
        stageName: stage.stageName,
      });
      expect(restored.tracingEnabled).toBe(true);
      expect(restored.variables?.K).toEqual("desired");

      yield* stack.destroy();
    }),
);
