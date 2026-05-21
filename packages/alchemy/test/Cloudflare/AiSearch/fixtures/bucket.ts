import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * Shared R2 bucket that the AiSearch binding indexes in tests. Stable name
 * keeps the resource identity deterministic across test runs.
 */
export const Bucket = Cloudflare.R2Bucket("AiSearchTestBucket", {
  name: "alchemy-test-ai-search-bucket",
});
