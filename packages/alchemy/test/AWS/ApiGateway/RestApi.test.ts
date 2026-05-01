import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create and delete REST API", (stack) =>
  Effect.gen(function* () {
    const api = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AWS.ApiGateway.RestApi("AgRestApiLifecycle", {
          name: "alchemy-test-ag-restapi-lifecycle",
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

test.provider("binary media types update applies via patch", (stack) =>
  Effect.gen(function* () {
    const api = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AWS.ApiGateway.RestApi("AgRestApiBinary", {
          name: "alchemy-test-ag-restapi-binary",
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
          name: "alchemy-test-ag-restapi-binary",
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
