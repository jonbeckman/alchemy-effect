import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { AiSearchBinding } from "./AiSearchBinding.ts";

export type AiSearchType = "r2" | "web-crawler";
export type R2Jurisdiction = "default" | "eu" | "fedramp";

export type AiSearchR2Source = {
  type: "r2";
  /**
   * Name of the R2 bucket to index. Pass `bucket.bucketName` to reference an
   * `R2Bucket` resource created in the same stack.
   */
  bucketName: string;
  /**
   * Object-key prefix to index. Defaults to the whole bucket.
   */
  prefix?: string;
  /**
   * Up to 10 wildcard patterns of object keys to include.
   */
  includePaths?: string[];
  /**
   * Up to 10 wildcard patterns of object keys to exclude.
   */
  excludePaths?: string[];
  /**
   * Jurisdiction of the R2 bucket. Defaults to `"default"`.
   */
  jurisdiction?: R2Jurisdiction;
};

export type AiSearchWebCrawlerSource = {
  type: "web-crawler";
  /**
   * Domain to crawl. Must be onboarded to your Cloudflare account.
   *
   * @example "docs.example.com"
   */
  domain: string;
  /**
   * Up to 10 wildcard patterns of URL paths to include.
   */
  includePaths?: string[];
  /**
   * Up to 10 wildcard patterns of URL paths to exclude.
   */
  excludePaths?: string[];
  /**
   * How the crawler discovers pages. Defaults to `"sitemap"`.
   */
  parseType?: "sitemap" | "feed-rss";
};

export type AiSearchSource = AiSearchR2Source | AiSearchWebCrawlerSource;

export type AiSearchModel = NonNullable<
  aisearch.CreateInstanceRequest["aiSearchModel"]
>;
export type AiSearchEmbeddingModel = NonNullable<
  aisearch.CreateInstanceRequest["embeddingModel"]
>;
export type AiSearchRerankingModel = NonNullable<
  aisearch.CreateInstanceRequest["rerankingModel"]
>;

export type AiSearchProps = {
  /**
   * Stable instance name (1–32 characters, lowercase, alphanumeric + `-`/`_`).
   * If omitted, a unique name is generated from `${app}-${stage}-${id}`.
   * Changing this triggers replacement.
   */
  name?: string;
  /**
   * Service token used to access the data source. Required by the Cloudflare
   * AI Search API for both `r2` and `web-crawler` sources. Pass the UUID of
   * an existing service token.
   */
  tokenId: string;
  /**
   * Data source for indexing. Either an R2 bucket or a web crawler.
   */
  source: AiSearchSource;
  /**
   * Text generation model used for answer synthesis.
   * @default "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
   */
  aiSearchModel?: AiSearchModel;
  /**
   * Embedding model used to vectorize source documents.
   * @default "@cf/baai/bge-m3"
   */
  embeddingModel?: AiSearchEmbeddingModel;
  /**
   * Enable chunking of source documents.
   * @default true
   */
  chunk?: boolean;
  /**
   * Size of each chunk (>= 64).
   * @default 256
   */
  chunkSize?: number;
  /**
   * Overlap between chunks (0–30).
   * @default 10
   */
  chunkOverlap?: number;
  /**
   * Maximum number of search results returned (1–50).
   * @default 10
   */
  maxNumResults?: number;
  /**
   * Minimum similarity score for results (0–1).
   * @default 0.4
   */
  scoreThreshold?: number;
  /**
   * Enable result reranking.
   * @default false
   */
  reranking?: boolean;
  /**
   * Reranking model used when `reranking` is enabled.
   * @default "@cf/baai/bge-reranker-base"
   */
  rerankingModel?: AiSearchRerankingModel;
  /**
   * Enable query rewriting for better retrieval.
   * @default false
   */
  rewriteQuery?: boolean;
  /**
   * Pause the instance — no new indexing jobs run while paused.
   * @default false
   */
  paused?: boolean;
};

export type AiSearch = Resource<
  "Cloudflare.AiSearch",
  AiSearchProps,
  {
    instanceName: string;
    accountId: string;
    type: AiSearchType;
    /** Source identifier — bucket name for `r2`, domain for `web-crawler`. */
    source: string;
    tokenId: string;
    vectorizeName: string | undefined;
    aiSearchModel: AiSearchModel | undefined;
    embeddingModel: AiSearchEmbeddingModel | undefined;
    chunk: boolean;
    chunkSize: number;
    chunkOverlap: number;
    maxNumResults: number;
    scoreThreshold: number;
    reranking: boolean;
    rerankingModel: AiSearchRerankingModel | undefined;
    rewriteQuery: boolean;
    paused: boolean;
  },
  never,
  Providers
>;

export const isAiSearch = (value: unknown): value is AiSearch =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as AiSearch).Type === "Cloudflare.AiSearch";

/**
 * A Cloudflare AI Search instance — a managed RAG index over an R2 bucket
 * or a crawled website. Bind it to a Worker to query the index at runtime.
 *
 * @section Creating an AI Search instance
 * @example R2-backed instance
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("Docs");
 * const search = yield* Cloudflare.AiSearch("DocsSearch", {
 *   tokenId: process.env.AI_SEARCH_TOKEN_ID!,
 *   source: { type: "r2", bucketName: bucket.bucketName },
 * });
 * ```
 *
 * @example Web-crawler instance
 * ```typescript
 * const search = yield* Cloudflare.AiSearch("SiteSearch", {
 *   tokenId: process.env.AI_SEARCH_TOKEN_ID!,
 *   source: { type: "web-crawler", domain: "docs.example.com" },
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Search from a Worker
 * ```typescript
 * const search = yield* Cloudflare.AiSearch.bind(DocsSearch);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const result = yield* search.search({ query: "how does caching work?" });
 *     return HttpServerResponse.json(result);
 *   }),
 * };
 * ```
 */
export const AiSearch = Resource<AiSearch>("Cloudflare.AiSearch")({
  bind: AiSearchBinding.bind,
});

const createInstanceName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return (yield* createPhysicalName({
      id,
      maxLength: 32,
      lowercase: true,
    })).toLowerCase();
  });

const sourceIdentifier = (source: AiSearchSource): string =>
  source.type === "r2" ? source.bucketName : source.domain;

const sourceParams = (source: AiSearchSource) => {
  if (source.type === "r2") {
    return {
      includeItems: source.includePaths,
      excludeItems: source.excludePaths,
      prefix: source.prefix,
      r2Jurisdiction:
        source.jurisdiction && source.jurisdiction !== "default"
          ? source.jurisdiction
          : undefined,
    };
  }
  return {
    includeItems: source.includePaths,
    excludeItems: source.excludePaths,
    webCrawler: {
      parseType: source.parseType,
    },
  };
};

const mutable = (p: AiSearchProps) => ({
  aiSearchModel: p.aiSearchModel,
  embeddingModel: p.embeddingModel,
  chunk: p.chunk ?? true,
  chunkSize: p.chunkSize ?? 256,
  chunkOverlap: p.chunkOverlap ?? 10,
  maxNumResults: p.maxNumResults ?? 10,
  scoreThreshold: p.scoreThreshold ?? 0.4,
  reranking: p.reranking ?? false,
  rerankingModel: p.rerankingModel,
  rewriteQuery: p.rewriteQuery ?? false,
  paused: p.paused ?? false,
  tokenId: p.tokenId,
  sourceParams: sourceParams(p.source),
});

const mapResponse = (
  res:
    | aisearch.CreateInstanceResponse
    | aisearch.UpdateInstanceResponse
    | aisearch.ReadInstanceResponse,
  accountId: string,
): AiSearch["Attributes"] => ({
  instanceName: res.id,
  accountId,
  type: (res.type ?? "r2") as AiSearchType,
  source: res.source ?? "",
  tokenId: res.tokenId ?? "",
  vectorizeName: res.vectorizeName ?? undefined,
  aiSearchModel: (res.aiSearchModel || undefined) as AiSearchModel | undefined,
  embeddingModel: (res.embeddingModel || undefined) as
    | AiSearchEmbeddingModel
    | undefined,
  chunk: res.chunk ?? true,
  chunkSize: res.chunkSize ?? 256,
  chunkOverlap: res.chunkOverlap ?? 10,
  maxNumResults: res.maxNumResults ?? 10,
  scoreThreshold: res.scoreThreshold ?? 0.4,
  reranking: res.reranking ?? false,
  rerankingModel: (res.rerankingModel || undefined) as
    | AiSearchRerankingModel
    | undefined,
  rewriteQuery: res.rewriteQuery ?? false,
  paused: res.paused ?? false,
});

export const AiSearchProvider = () =>
  Provider.effect(
    AiSearch,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createInstance = yield* aisearch.createInstance;
      const readInstance = yield* aisearch.readInstance;
      const updateInstance = yield* aisearch.updateInstance;
      const deleteInstance = yield* aisearch.deleteInstance;

      return {
        stables: ["instanceName", "accountId", "type", "source"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (news === undefined || !isResolved(news)) return undefined;
          if (olds !== undefined && !isResolved(olds)) return undefined;
          const next = news as AiSearchProps;
          const prev = olds as Partial<AiSearchProps> | undefined;
          const nextName = yield* createInstanceName(id, next.name);
          const oldName =
            output?.instanceName ?? (yield* createInstanceName(id, prev?.name));
          const oldType = output?.type ?? prev?.source?.type;
          const oldSource =
            output?.source ??
            (prev?.source ? sourceIdentifier(prev.source) : undefined);
          if (
            (output?.accountId ?? accountId) !== accountId ||
            oldName !== nextName ||
            (oldType !== undefined && oldType !== next.source.type) ||
            (oldSource !== undefined &&
              oldSource !== sourceIdentifier(next.source))
          ) {
            return { action: "replace" } as const;
          }
          if (!prev || !prev.source) {
            return { action: "update" } as const;
          }
          const oldMutable = mutable(prev as AiSearchProps);
          const nextMutable = mutable(next);
          if (!deepEqual(oldMutable, nextMutable)) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const next = news as AiSearchProps;
          const acct = output?.accountId ?? accountId;
          const instanceName =
            output?.instanceName ?? (yield* createInstanceName(id, next.name));

          // Observe — readInstance returns NotFound if the instance doesn't
          // exist yet (or was deleted out of band).
          const observed = yield* readInstance({
            accountId: acct,
            id: instanceName,
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

          // Ensure — create when missing. The AI Search create API returns
          // a validation error if the instance already exists; on that race
          // we re-read instead.
          if (observed === undefined) {
            yield* createInstance({
              accountId: acct,
              id: instanceName,
              source: sourceIdentifier(next.source),
              type: next.source.type,
              tokenId: next.tokenId,
              aiSearchModel: next.aiSearchModel,
              embeddingModel: next.embeddingModel,
              chunk: next.chunk,
              chunkSize: next.chunkSize,
              chunkOverlap: next.chunkOverlap,
              maxNumResults: next.maxNumResults,
              scoreThreshold: next.scoreThreshold,
              reranking: next.reranking,
              rerankingModel: next.rerankingModel,
              rewriteQuery: next.rewriteQuery,
              sourceParams: sourceParams(next.source),
            }).pipe(
              Effect.catchTag("ValidationError", () =>
                readInstance({ accountId: acct, id: instanceName }),
              ),
            );
          }

          // Sync — the AI Search update API is a full PATCH over mutable
          // fields. Always apply so adoption, drift, and routine updates
          // converge.
          const updated = yield* updateInstance({
            accountId: acct,
            id: instanceName,
            aiSearchModel: next.aiSearchModel,
            embeddingModel: next.embeddingModel,
            chunk: next.chunk,
            chunkOverlap: next.chunkOverlap,
            chunkSize: next.chunkSize,
            maxNumResults: next.maxNumResults,
            scoreThreshold: next.scoreThreshold,
            reranking: next.reranking,
            rerankingModel: next.rerankingModel,
            rewriteModel: next.aiSearchModel,
            rewriteQuery: next.rewriteQuery,
            paused: next.paused,
            sourceParams: sourceParams(next.source),
          });
          return mapResponse(updated, acct);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteInstance({
            accountId: output.accountId,
            id: output.instanceName,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const acct = output?.accountId ?? accountId;
          const instanceName =
            output?.instanceName ?? (yield* createInstanceName(id, olds?.name));
          return yield* readInstance({
            accountId: acct,
            id: instanceName,
          }).pipe(
            Effect.map((res) => mapResponse(res, acct)),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
