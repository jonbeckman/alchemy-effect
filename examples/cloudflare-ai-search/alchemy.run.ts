import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Bucket } from "./src/Bucket.ts";
import { Search } from "./src/Search.ts";

export default Alchemy.Stack(
  "CloudflareAiSearchExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Bucket;
    const search = yield* Search;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      bucket: bucket.bucketName,
      searchInstance: search.instanceName,
    };
  }),
);
