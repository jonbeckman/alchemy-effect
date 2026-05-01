import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create and delete gateway response", (stack) =>
  Effect.gen(function* () {
    const { api } = yield* stack.deploy(
      Effect.gen(function* () {
        const api = yield* AWS.ApiGateway.RestApi("AgGwRespApi", {
          name: "alchemy-test-ag-gateway-response",
          endpointConfiguration: { types: ["REGIONAL"] },
        });
        yield* AWS.ApiGateway.GatewayResponse("AgDefault4xx", {
          restApiId: api.restApiId,
          responseType: "DEFAULT_4XX",
          responseTemplates: {
            "application/json": '{"message":"test"}',
          },
        });
        return { api };
      }),
    );

    const g = yield* ag.getGatewayResponse({
      restApiId: api.restApiId,
      responseType: "DEFAULT_4XX",
    });
    expect(g.responseType).toEqual("DEFAULT_4XX");

    yield* stack.destroy();
  }),
);
