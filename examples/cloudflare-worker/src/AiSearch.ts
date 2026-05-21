import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Bucket } from "./Bucket.ts";

/**
 * AI Search instance indexing the example's R2 bucket.
 *
 * `AI_SEARCH_TOKEN_ID` must be a pre-provisioned AI Search service token
 * UUID — Cloudflare requires one for R2-backed instances.
 */
export const Search = Effect.gen(function* () {
  const bucket = yield* Bucket;
  return yield* Cloudflare.AiSearch("Search", {
    tokenId: process.env.AI_SEARCH_TOKEN_ID!,
    source: { type: "r2", bucketName: bucket.bucketName },
  });
});
