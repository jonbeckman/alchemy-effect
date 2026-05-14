import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Chat, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BackingPersistence } from "effect/unstable/persistence/Persistence";

export const ModelOptions = ["kimi", "gpt", "claude"] as const;
export type ModelOption = (typeof ModelOptions)[number];
export const isModelOption = (value: unknown): value is ModelOption =>
  typeof value === "string" &&
  (ModelOptions as readonly string[]).includes(value);

export const Gateway = Cloudflare.AiGateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

// ──────────────────────────────────────────────────────────────────────
// Tools the model can call
// ──────────────────────────────────────────────────────────────────────

const GetCurrentTime = Tool.make("get_current_time", {
  description:
    "Returns the current server-side wall-clock time. Call this whenever the user asks about the current time, date, or day.",
  success: Schema.Struct({
    iso: Schema.String,
    unixMs: Schema.Number,
  }),
});

const Calculate = Tool.make("calculate", {
  description:
    "Evaluates a basic arithmetic expression over numbers. Supported operators: + - * / and parentheses. Use this for any math the user asks for.",
  parameters: Schema.Struct({
    expression: Schema.String,
  }),
  success: Schema.Struct({
    expression: Schema.String,
    result: Schema.Number,
    error: Schema.optional(Schema.String),
  }),
});

const RollDice = Tool.make("roll_dice", {
  description:
    'Rolls one or more N-sided dice and returns each roll plus the total. Use this when the user asks to roll dice (e.g. "roll 2d6").',
  parameters: Schema.Struct({
    sides: Schema.Number,
    count: Schema.Number,
  }),
  success: Schema.Struct({
    rolls: Schema.Array(Schema.Number),
    total: Schema.Number,
  }),
});

const ChatToolkit = Toolkit.make(GetCurrentTime, Calculate, RollDice);

const ChatToolkitLayer = ChatToolkit.toLayer({
  get_current_time: () =>
    Effect.sync(() => {
      const now = new Date();
      return { iso: now.toISOString(), unixMs: now.getTime() };
    }),
  calculate: ({ expression }) =>
    Effect.sync(() => {
      try {
        if (!/^[\d+\-*/().\s]+$/.test(expression)) {
          return {
            expression,
            result: 0,
            error: "expression contains unsupported characters",
          };
        }
        const result = Function(`"use strict"; return (${expression});`)();
        if (typeof result !== "number" || !Number.isFinite(result)) {
          return {
            expression,
            result: 0,
            error: "expression did not evaluate to a finite number",
          };
        }
        return { expression, result };
      } catch (cause) {
        return {
          expression,
          result: 0,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  roll_dice: ({ sides, count }) =>
    Effect.sync(() => {
      const safeSides = Math.max(1, Math.floor(sides));
      const safeCount = Math.min(20, Math.max(1, Math.floor(count)));
      const rolls: Array<number> = [];
      for (let i = 0; i < safeCount; i++) {
        rolls.push(1 + Math.floor(Math.random() * safeSides));
      }
      return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
    }),
});

const SYSTEM_PROMPT = `You are a friendly assistant running on Cloudflare Workers AI.
You have access to tools — prefer calling a tool over making up an answer when one is relevant.
Available tools:
- get_current_time: current server time
- calculate: arithmetic over numbers
- roll_dice: roll N-sided dice
After a tool returns, weave its result into a natural reply.`;

// ──────────────────────────────────────────────────────────────────────
// Durable Object
// ──────────────────────────────────────────────────────────────────────

/**
 * A Durable Object that owns one persisted chat session per DO instance.
 *
 * The chat history lives inside the DO's `state.storage`, so the conversation
 * survives across DO invocations — every call to `getByName(id)` for the same
 * `id` reuses the same chat thread.
 */
export default class ChatAgent extends Cloudflare.DurableObjectNamespace<ChatAgent>()(
  "ChatAgent",
  Effect.gen(function* () {
    const ai = yield* Cloudflare.AiGateway.bind(Gateway);
    const openAiKey = yield* Alchemy.Secret("OPENAI_API_KEY");
    const anthropicKey = yield* Alchemy.Secret("ANTHROPIC_API_KEY");

    // Workers AI is constructed eagerly — `aiGateway.model` already
    // resolves through Cloudflare's `Ai` binding, no API key needed.
    const kimi = ai.model({
      client: ai,
      // Kimi K2.6 has strong tool-calling and a generous 262k context.
      model: "@cf/moonshotai/kimi-k2.6",
      parameters: { temperature: 0.3, maxTokens: 1024 },
    });

    // OpenAI and Anthropic need their secret API key, which only resolves
    // at runtime via the `Alchemy.Secret` accessor. `Layer.unwrapEffect`
    // defers the layer build until the accessor produces a `Redacted`.
    const gpt = Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* openAiKey;
        const eff = OpenAiLanguageModel.layer({
          model: "gpt-5.4-nano",
          config: { temperature: 0.3 },
        }).pipe(
          Layer.provide(OpenAiClient.layer({ apiKey })),
          Layer.provide(FetchHttpClient.layer),
        );
        return eff;
      }),
    );

    const claude = Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* anthropicKey;
        return AnthropicLanguageModel.layer({
          model: "claude-haiku-4-5",
          config: { max_tokens: 1024, temperature: 0.3 },
        }).pipe(
          Layer.provide(AnthropicClient.layer({ apiKey })),
          Layer.provide(FetchHttpClient.layer),
        );
      }),
    );

    const modelLayer = (option: ModelOption) => {
      switch (option) {
        case "kimi":
          return kimi;
        case "gpt":
          return gpt;
        case "claude":
          return claude;
      }
    };

    return Effect.gen(function* () {
      const persistence = yield* Chat.Persistence;
      // Hold onto the raw backing store so `reset` can hard-delete the
      // saved history. `chat.save({ content: [] })` looked like it should
      // work, but `Chat.Persistence` is a higher-level wrapper that
      // doesn't expose a `delete`; deleting the key directly is the
      // cleanest way to guarantee the next `getOrCreate` starts empty.
      const backing = yield* BackingPersistence;
      const store = yield* backing.make("chat");

      return {
        send: (threadId: string, prompt: string, model: ModelOption) =>
          Effect.gen(function* () {
            const chat = yield* persistence.getOrCreate(threadId);
            // Seed the system prompt on the first turn so the model knows
            // about the available tools.
            const history = yield* Ref.get(chat.history);
            if (history.content.length === 0) {
              yield* Ref.update(chat.history, (h) => ({
                ...h,
                content: [
                  Prompt.makeMessage("system", { content: SYSTEM_PROMPT }),
                  ...h.content,
                ],
              }));
            }
            const response = yield* chat.generateText({
              prompt,
              toolkit: ChatToolkit,
            });
            const finalHistory = yield* Ref.get(chat.history);
            return {
              reply: response.text,
              model,
              messages: exportMessages(finalHistory),
            };
          }).pipe(
            Effect.provide(Layer.mergeAll(modelLayer(model), ChatToolkitLayer)),
            // Log full cause (including AiError's underlying cause) so a bad
            // API key / network error / model-not-available surfaces in logs.
            Effect.tapCause((cause) =>
              Effect.logError(`ChatAgent.send failed`, cause),
            ),
            // Bounded retry — without `times` the worker spins on bad creds.
            Effect.retry({
              while: (err) => err._tag === "AiError",
              times: 2,
            }),
          ),

        messages: (threadId: string) =>
          Effect.gen(function* () {
            const chat = yield* persistence.getOrCreate(threadId);
            const history = yield* Ref.get(chat.history);
            return { messages: exportMessages(history) };
          }),

        reset: (threadId: string) =>
          Effect.gen(function* () {
            yield* store.remove(threadId).pipe(Effect.orDie);
            return { messages: [] as ReadonlyArray<ChatMessage> };
          }),
      };
    }).pipe(
      Effect.provide(
        Chat.layerPersisted({ storeId: "chat" }).pipe(
          Layer.provideMerge(Cloudflare.DurableObjectChatPersistence),
        ),
      ),
      Effect.orDie,
    );
  }),
) {}

const collectText = (
  parts: ReadonlyArray<Prompt.UserMessagePart | Prompt.AssistantMessagePart>,
): string => {
  let out = "";
  for (const part of parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
};

const exportMessages = (history: Prompt.Prompt): ReadonlyArray<ChatMessage> => {
  const out: Array<ChatMessage> = [];
  for (const msg of history.content) {
    // Only user/assistant turns are surfaced to the UI; system prompts and
    // tool messages stay internal.
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = messageText(msg);
    if (text.length === 0) continue;
    out.push({ role: msg.role, text });
  }
  return out;
};

const messageText = (msg: Prompt.Message): string => {
  switch (msg.role) {
    case "user":
    case "assistant":
      return collectText(msg.content);
    default:
      return "";
  }
};
