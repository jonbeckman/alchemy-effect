import * as AWS from "@/aws";
import * as Lambda from "@/aws/lambda";
import { $, apply, destroy } from "@/index";
import { test } from "@/Test/Vitest";
import * as Effect from "effect/Effect";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "..", "..", "handler.ts");

test(
  "create, update, delete function",
  Effect.gen(function* () {
    class MyFunction extends Lambda.serve("MyFunction", {
      fetch: Effect.fn(function* (event) {
        return {
          body: "Hello, world!",
        };
      }),
    })({
      main,
      bindings: $(),
    }) {}

    const stack = yield* apply(MyFunction);

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);
