import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";
import type { Providers } from "../Providers.ts";

export type SecretsStoreProps = {
  /**
   * Name of the store to adopt. If omitted, the first store found on the
   * account is adopted automatically.
   */
  name?: string;
};

export type SecretsStore = Resource<
  "Cloudflare.SecretsStore",
  SecretsStoreProps,
  {
    storeId: string;
    storeName: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Secrets Store, a per-account container for secrets that
 * can be bound into Workers with full redaction and audit support.
 *
 * Cloudflare enforces a limit of **one Secrets Store per account**.
 * Deleting a store changes its ID and permanently destroys all secrets
 * inside it. Because of this, the provider always **adopts** an existing
 * store rather than creating a new one, and **never deletes** the store
 * on teardown. If no store exists yet, one is created, but once it
 * exists it is treated as account-level infrastructure that outlives
 * any single stack.
 *
 * @section Creating a Store
 * @example Basic Secrets Store (adopts existing or creates one)
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore("MyStore");
 * ```
 *
 * @example Adopt a specific named store
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore("MyStore", {
 *   name: "production-secrets",
 * });
 * ```
 */
export const SecretsStore = Resource<SecretsStore>("Cloudflare.SecretsStore");

export const SecretsStoreProvider = () =>
  Provider.effect(
    SecretsStore,
    Effect.gen(function* () {
      const accountId = yield* Account;
      const createStore = yield* secretsStore.createStore;
      const listStores = yield* secretsStore.listStores;

      return {
        stables: ["storeId", "storeName", "accountId"],
        create: Effect.fn(function* ({ news = {} }) {
          // Always try to adopt an existing store first.
          // Cloudflare only allows one store per account — deleting it
          // destroys all secrets and changes the ID, so we avoid ever
          // creating a second one.
          const stores = yield* listStores({ accountId });
          if (news.name) {
            const match = stores.result.find((s) => s.name === news.name);
            if (match) {
              return {
                storeId: match.id,
                storeName: match.name,
                accountId,
              };
            }
          } else if (stores.result.length > 0) {
            // No name specified — adopt the first (and likely only) store.
            const first = stores.result[0]!;
            return {
              storeId: first.id,
              storeName: first.name,
              accountId,
            };
          }

          // No store exists yet — create one.
          const name = news.name ?? "secrets";
          const response = yield* createStore({
            accountId,
            body: [{ name }],
          });
          const store = response.result[0]!;
          return {
            storeId: store.id,
            storeName: store.name,
            accountId,
          };
        }),
        update: Effect.fn(function* ({ output }) {
          return output;
        }),
        delete: Effect.fn(function* () {
          // Intentional no-op. Cloudflare only allows one Secrets Store per
          // account and deleting it permanently destroys all secrets inside.
          // The store is treated as shared, account-level infrastructure that
          // should never be torn down by a single stack.
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.storeId) return undefined;
          const stores = yield* listStores({
            accountId: output.accountId,
          });
          const match = stores.result.find((s) => s.id === output.storeId);
          if (!match) return undefined;
          return {
            storeId: match.id,
            storeName: match.name,
            accountId: output.accountId,
          };
        }),
      };
    }),
  );
