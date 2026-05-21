import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { Bucket } from "./bucket.ts";

/**
 * AI Search instance indexed against the shared R2 bucket. `AI_SEARCH_TOKEN_ID`
 * is a pre-provisioned AI Search service token UUID (Cloudflare requires one
 * for R2-backed instances).
 */
export const Search = Effect.gen(function* () {
  const bucket = yield* Bucket;
  return yield* Cloudflare.AiSearch("AiSearchTestInstance", {
    name: "alchemy-test-ai-search",
    tokenId: process.env.AI_SEARCH_TOKEN_ID!,
    source: { type: "r2", bucketName: bucket.bucketName },
  });
});
