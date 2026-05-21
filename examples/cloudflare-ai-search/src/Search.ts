import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Bucket } from "./Bucket.ts";

/**
 * AI Search instance indexing the example's R2 bucket.
 *
 * Cloudflare AI Search requires a service token to read from R2. Pass the
 * token UUID via `AI_SEARCH_TOKEN_ID` — see the README for how to mint one.
 */
export const Search = Effect.gen(function* () {
  const bucket = yield* Bucket;
  return yield* Cloudflare.AiSearch("DocsSearch", {
    tokenId: process.env.AI_SEARCH_TOKEN_ID!,
    source: { type: "r2", bucketName: bucket.bucketName },
    chunkSize: 256,
    chunkOverlap: 10,
    maxNumResults: 10,
  });
});
