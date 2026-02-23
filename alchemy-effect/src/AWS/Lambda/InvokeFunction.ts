import * as Lambda from "distilled-aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import type { Function } from "./Function.ts";
import * as LambdaModule from "./index.ts";

export interface InvokeRequest extends Omit<
  Lambda.InvocationRequest,
  "FunctionName"
> {}

export const InvokeFunction = Effect.fn(function* <F extends Function>(func: F) {
  yield* bindInvokeFunction(func);
  const FunctionArn = yield* func.functionArn();
  Effect.fn("AWS.Lambda.InvokeFunction")(function* (request?: InvokeRequest) {
    return yield* Lambda.invoke({
      ...request,
      FunctionName: yield* FunctionArn,
    });
  });
});

export const bindInvokeFunction = Binding.fn<InvokeFunctionBinding>(
  "AWS.Lambda.InvokeFunction",
);

export class InvokeFunctionBinding extends Binding.Service(
  "AWS.Lambda.InvokeFunction",
  Effect.fn(function* <F extends Function>(func: F) {
    const runtime = yield* Runtime;
    if (LambdaModule.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "InvokeFunction",
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [Output.interpolate`${func.functionArn()}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `InvokeFunctionBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
