import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags } from "../../Tags.ts";

import { apiKeyArn, syncTags } from "./common.ts";

export interface ApiKeyProps {
  name?: string;
  description?: string;
  enabled?: boolean;
  generateDistinctId?: boolean;
  /**
   * Write-only value when creating; never stored in resource state or outputs.
   */
  value?: string;
  stageKeys?: ag.StageKey[];
  customerId?: string;
  tags?: Record<string, string>;
}

export interface ApiKey extends Resource<
  "AWS.ApiGateway.ApiKey",
  ApiKeyProps,
  {
    id: string;
    name: string | undefined;
    enabled: boolean | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * API Gateway API key for usage plans and `apiKeyRequired` methods.
 *
 * @section API keys
 * @example Generated key
 * ```typescript
 * const key = yield* ApiGateway.ApiKey("PartnerKey", {
 *   name: "partner",
 *   generateDistinctId: true,
 * });
 * ```
 */
const ApiKeyResource = Resource<ApiKey>("AWS.ApiGateway.ApiKey");

export { ApiKeyResource as ApiKey };

const toTags = (tags: ag.ApiKey["tags"]) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKeyResource,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["id"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as ApiKeyProps;
          if (
            news.value !== olds.value ||
            news.customerId !== olds.customerId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const k = yield* ag
            .getApiKey({ apiKey: output.id, includeValue: false })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!k?.id) return undefined;
          return {
            id: k.id,
            name: k.name,
            enabled: k.enabled,
            tags: toTags(k.tags),
          };
        }),
        create: Effect.fn(function* ({ id, news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("ApiKey props were not resolved");
          }
          const news = newsIn as ApiKeyProps;
          const internalTags = yield* createInternalTags(id);
          const allTags = { ...news.tags, ...internalTags };

          const k = yield* ag.createApiKey({
            name: news.name,
            description: news.description,
            enabled: news.enabled,
            generateDistinctId: news.generateDistinctId,
            value: news.value,
            stageKeys: news.stageKeys,
            customerId: news.customerId,
            tags: allTags,
          });
          if (!k.id) return yield* Effect.die("createApiKey missing id");
          yield* session.note(`Created API key ${k.id}`);
          const full = yield* ag.getApiKey({
            apiKey: k.id,
            includeValue: false,
          });
          if (!full.id) return yield* Effect.die("getApiKey missing id");
          return {
            id: full.id,
            name: full.name,
            enabled: full.enabled,
            tags: toTags(full.tags),
          };
        }),
        update: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("ApiKey props were not resolved");
          }
          const news = newsIn as ApiKeyProps;
          const patches: ag.PatchOperation[] = [];
          if (news.name !== output.name) {
            patches.push({
              op: "replace",
              path: "/name",
              value: news.name ?? "",
            });
          }
          if (news.description !== undefined) {
            patches.push({
              op: "replace",
              path: "/description",
              value: news.description ?? "",
            });
          }
          if (news.enabled !== undefined && news.enabled !== output.enabled) {
            patches.push({
              op: "replace",
              path: "/enabled",
              value: String(news.enabled),
            });
          }
          if (patches.length > 0) {
            yield* ag.updateApiKey({
              apiKey: output.id,
              patchOperations: patches,
            });
          }

          const internalTags = yield* createInternalTags(id);
          const newTags = { ...news.tags, ...internalTags };
          if (!deepEqual(output.tags, newTags)) {
            yield* syncTags({
              resourceArn: apiKeyArn(awsRegion, output.id),
              oldTags: output.tags,
              newTags,
            });
          }

          yield* session.note(`Updated API key ${output.id}`);
          const full = yield* ag.getApiKey({
            apiKey: output.id,
            includeValue: false,
          });
          return {
            id: output.id,
            name: full.name,
            enabled: full.enabled,
            tags: toTags(full.tags),
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteApiKey({ apiKey: output.id })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted API key ${output.id}`);
        }),
      };
    }),
  );
