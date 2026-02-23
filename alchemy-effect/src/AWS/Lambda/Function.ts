import * as Effect from "effect/Effect";
import * as Alchemy from "../../index.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";

import type * as lambda from "aws-lambda";
import type { Input } from "../../index.ts";
import type { EventRuntimeService } from "../../Runtime.ts";

export type Context = lambda.Context;

export interface FunctionBindingProps {
  env?: Record<string, any>;
  policyStatements?: PolicyStatement[];
}

export interface FunctionProps<Services = any, Err = never, Req = never> {
  main: string;
  handler: Effect.Effect<
    (event: any, context: Context) => Effect.Effect<any, Err, Req>,
    Err,
    Req
  >;
  url?: boolean;
  functionName?: string;
  services: Services[];
}

export const isFunction = <T>(value: T): value is T & Function => {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "function"
  );
};

export const Function = Alchemy.Resource<{
  env: Record<string, Input<string>>;
  policyStatements: Input<PolicyStatement[]>;
  <const Id extends string, const Props extends FunctionProps = never>(
    id: Id,
    props?: Props,
  ): Effect.Effect<Function<Id, Props>>;
}>("AWS.Lambda.Function");

export interface Function<
  Id extends string = string,
  Props extends FunctionProps = any,
>
  extends
    EventRuntimeService<"AWS.Lambda.Function">,
    Alchemy.Resource<
      "AWS.Lambda.Function",
      Id,
      Props,
      {
        functionArn: string;
        functionName: string;
        functionUrl: Props["url"] extends true ? string : undefined;
        roleName: string;
        roleArn: string;
        code: {
          hash: string;
        };
      },
      {
        policyStatements?: PolicyStatement[];
        env?: Record<string, Input<string>>;
      }
    > {}
