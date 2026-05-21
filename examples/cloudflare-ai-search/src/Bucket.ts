import * as Cloudflare from "alchemy/Cloudflare";

/**
 * R2 bucket whose objects feed the AI Search index.
 */
export const Bucket = Cloudflare.R2Bucket("DocsBucket");
