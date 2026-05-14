import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import ChatAgent, { isModelOption, type ModelOption } from "./Agent.ts";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (body: unknown, init?: { status?: number }) =>
  HttpServerResponse.json(body, {
    status: init?.status,
    headers: corsHeaders,
  });

/**
 * Backend Worker for the chat bot SPA.
 *
 * Routes:
 * - `POST /api/chat?id=:sessionId&threadId=:threadId` — send a prompt, get the
 *   assistant reply plus the full conversation history.
 * - `GET  /api/messages?id=:sessionId&threadId=:threadId` — fetch the existing
 *   conversation for a session/thread.
 * - `POST /api/reset?id=:sessionId&threadId=:threadId` — clear the thread.
 *
 * Every session maps to a single `ChatAgent` Durable Object instance
 * (`agents.getByName(id)`), so history is naturally per-session. The DO holds
 * the Effect-native `Chat` with persistence wired to the DO's own storage.
 */
export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const agents = yield* ChatAgent;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({
            status: 204,
            headers: corsHeaders,
          });
        }

        const id = url.searchParams.get("id") ?? "default";
        const threadId = url.searchParams.get("threadId") ?? "default";
        const agent = agents.getByName(id);

        if (url.pathname === "/api/chat" && request.method === "POST") {
          const body = (yield* request.json) as {
            prompt?: string;
            model?: string;
          };
          const prompt = body.prompt?.trim();
          if (!prompt) {
            return yield* json(
              { error: "prompt is required" },
              { status: 400 },
            );
          }
          const model: ModelOption = isModelOption(body.model)
            ? body.model
            : "kimi";
          return yield* agent
            .send(threadId, prompt, model)
            .pipe(Effect.flatMap((result) => json(result)));
        }

        if (url.pathname === "/api/messages" && request.method === "GET") {
          return yield* agent
            .messages(threadId)
            .pipe(Effect.flatMap((result) => json(result)));
        }

        if (url.pathname === "/api/reset" && request.method === "POST") {
          return yield* agent
            .reset(threadId)
            .pipe(Effect.flatMap((result) => json(result)));
        }

        return HttpServerResponse.text("Not Found", {
          status: 404,
          headers: corsHeaders,
        });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.AiGatewayBindingLive)),
) {}
