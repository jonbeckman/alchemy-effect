import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Bucket } from "./Bucket.ts";
import { Search } from "./Search.ts";

/**
 * Worker that puts content into the R2 bucket and queries the AI Search
 * index bound to it.
 *
 *  - `POST /docs/:key` — body becomes the contents of an R2 object indexed
 *    by AI Search (re-indexing happens on Cloudflare's schedule).
 *  - `GET  /search/info`       — round-trip the runtime binding.
 *  - `POST /search/query`      — run `{ query }` against the index.
 *  - `POST /search/chat`       — run `{ messages }` chat completions.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);
    const search = yield* Cloudflare.AiSearch.bind(Search);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname.startsWith("/docs/") && request.method === "POST") {
          const key = url.pathname.slice("/docs/".length);
          if (!key) {
            return HttpServerResponse.text("missing key", { status: 400 });
          }
          return yield* bucket
            .put(key, request.stream, {
              contentLength: Number(request.headers["content-length"] ?? 0),
            })
            .pipe(
              Effect.map(() => HttpServerResponse.empty({ status: 201 })),
              Effect.catchTag("R2Error", (err) =>
                Effect.succeed(
                  HttpServerResponse.text(err.message, { status: 500 }),
                ),
              ),
            );
        }

        if (url.pathname === "/search/info" && request.method === "GET") {
          return yield* search.info().pipe(
            Effect.flatMap((info) => HttpServerResponse.json(info)),
            Effect.catchTag("AiSearchError", (err) =>
              HttpServerResponse.json({ error: err.message }, { status: 500 }),
            ),
          );
        }

        if (url.pathname === "/search/query" && request.method === "POST") {
          const text = yield* request.text;
          const body = safeJson<{ query?: string }>(text);
          const query = body.query?.trim();
          if (!query) {
            return HttpServerResponse.json(
              { error: "query is required" },
              { status: 400 },
            );
          }
          return yield* search.search({ query }).pipe(
            Effect.flatMap((res) => HttpServerResponse.json(res)),
            Effect.catchTag("AiSearchError", (err) =>
              HttpServerResponse.json({ error: err.message }, { status: 500 }),
            ),
          );
        }

        if (url.pathname === "/search/chat" && request.method === "POST") {
          const text = yield* request.text;
          const body = safeJson<{
            messages?: { role: "user" | "assistant"; content: string }[];
          }>(text);
          const messages = body.messages;
          if (!messages || messages.length === 0) {
            return HttpServerResponse.json(
              { error: "messages is required" },
              { status: 400 },
            );
          }
          return yield* search.chatCompletions({ messages }).pipe(
            Effect.flatMap((res) => HttpServerResponse.json(res)),
            Effect.catchTag("AiSearchError", (err) =>
              HttpServerResponse.json({ error: err.message }, { status: 500 }),
            ),
          );
        }

        return HttpServerResponse.text(
          "POST /docs/:key, GET /search/info, POST /search/query, POST /search/chat",
        );
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.R2BucketBindingLive),
    Effect.provide(Cloudflare.AiSearchBindingLive),
  ),
) {}

const safeJson = <T>(text: string): T => {
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    return {} as T;
  }
};
