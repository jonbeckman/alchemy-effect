import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Chat } from "effect/unstable/ai";
import { Gateway } from "./Gateway.ts";

/**
 * A Durable Object that owns a single stateful chat session.
 *
 * - **Init phase** binds the AI Gateway client and constructs the
 *   `LanguageModel` layer.
 * - **Instance phase** wires `Chat.Persistence` on top of the DO's own
 *   `state.storage` (via `DurableObjectBackingPersistence`) and resolves a
 *   single persisted chat for this DO instance.
 *
 * Because the chat lives inside the DO, the conversation history survives
 * across DO invocations — `state.storage` is the persistence layer.
 */
export default class ChatAgent extends Cloudflare.DurableObjectNamespace<ChatAgent>()(
  "ChatAgent",
  Effect.gen(function* () {
    const ai = yield* Cloudflare.AiGateway.bind(Gateway);

    const model = ai.model({
      client: ai,
      model: "@cf/meta/llama-3.1-8b-instruct",
      parameters: { temperature: 0, maxTokens: 64 },
    });

    return Effect.gen(function* () {
      const persistence = yield* Chat.Persistence;
      return {
        send: (threadId: string, prompt: string) =>
          Effect.gen(function* () {
            const chat = yield* persistence.getOrCreate(threadId);
            const response = yield* chat.generateText({ prompt });
            const history = yield* Ref.get(chat.history);
            return { text: response.text, turns: history.content.length };
          }).pipe(
            Effect.provide(model),
            Effect.tapError(Effect.logError),
            Effect.retry({
              while: (err) => err._tag === "AiError",
            }),
          ),
      };
    }).pipe(
      Effect.provide(Chat.layerPersisted({ storeId: "chat" })),
      Effect.provide(Cloudflare.DurableObjectChatPersistence),
      Effect.orDie,
    );
  }),
) {}
