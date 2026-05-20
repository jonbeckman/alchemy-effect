import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import Stack from "../alchemy.run.ts";
import { Api } from "../src/http-worker.ts";
import { API } from "../src/rpc-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const makeClient = (url: string) =>
  RpcClient.make(API).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: url.replace(/\/+$/, "") }),
    ),
    Effect.provide(RpcSerialization.layerNdjson),
    Effect.provide(FetchHttpClient.layer),
  );

const getStackUrl = (out: unknown, key: "rpc" | "http") =>
  typeof out === "string" ? out : (out as Record<typeof key, string>)[key];

test(
  "handles 100 parallel rpc stream requests",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = getStackUrl(out, "rpc");
    expect(url).toBeString();

    const client = yield* makeClient(url);
    const requests = 100;
    const upto = 5;
    const expected = Array.from({ length: upto }, (_, i) => i);

    const results = yield* Effect.forEach(
      Array.from({ length: requests }, (_, i) => i),
      () =>
        client
          .Stream({ upto })
          .pipe(
            Stream.runCollect,
            Effect.timeout("30 seconds"),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
          ),
      { concurrency: requests },
    );

    expect(results).toHaveLength(requests);
    for (const result of results) {
      expect(result).toEqual(expected);
    }
  }),
  { timeout: 90_000 },
);

test(
  "handles 100 parallel rpc ping requests",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = getStackUrl(out, "rpc");
    expect(url).toBeString();

    const client = yield* makeClient(url);
    const requests = 100;

    yield* Effect.forEach(
      Array.from({ length: requests }, (_, i) => i),
      () => client.Ping().pipe(Effect.timeout("30 seconds")),
      { concurrency: requests },
    );
  }),
  { timeout: 90_000 },
);

test(
  "handles 100 parallel http api ping requests",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = getStackUrl(out, "http");
    expect(url).toBeString();

    const client = yield* HttpApiClient.make(Api, { baseUrl: url });
    const requests = 100;

    const results = yield* Effect.forEach(
      Array.from({ length: requests }, (_, i) => i),
      () =>
        client.Tasks.ping().pipe(
          Effect.timeout("30 seconds"),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
        ),
      { concurrency: requests },
    );

    expect(results).toHaveLength(requests);
    for (const result of results) {
      expect(result).toBe("pong");
    }
  }),
  { timeout: 90_000 },
);
