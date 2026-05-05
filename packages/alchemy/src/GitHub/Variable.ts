import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export interface VariableProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Variable name (e.g. `AWS_ROLE_ARN`).
   */
  name: string;

  /**
   * Variable value.
   */
  value: string;
}

export interface Variable extends Resource<
  "GitHub.Variable",
  VariableProps,
  {
    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub Actions repository variable.
 *
 * `Variable` manages the lifecycle of a plain-text configuration variable
 * in GitHub Actions. Variables are visible in workflow logs and are
 * suitable for non-sensitive configuration like region names, environment
 * labels, or feature flags. For sensitive values, use `GitHub.Secret`
 * instead.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (which uses the Alchemy AuthProvider — env,
 * stored PAT, `gh` CLI, or OAuth). The token needs `repo` scope for
 * private repositories or `public_repo` for public ones.
 *
 * @section Repository Variables
 * Store variables accessible to all GitHub Actions workflows in the
 * repository.
 *
 * @example Create a Repository Variable
 * ```typescript
 * yield* GitHub.Variable("aws-region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 * ```
 *
 * @section Wiring with Other Resources
 * Pass output attributes from other resources into GitHub variables so
 * that CI workflows can reference them.
 *
 * @example Store a Worker URL for CI
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Api", { ... });
 *
 * yield* GitHub.Variable("api-url", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "API_URL",
 *   value: worker.url!,
 * });
 * ```
 *
 * @example Multiple Variables
 * ```typescript
 * yield* GitHub.Variable("region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 *
 * yield* GitHub.Variable("stage", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "DEPLOY_STAGE",
 *   value: "production",
 * });
 * ```
 */
export const Variable = Resource<Variable>("GitHub.Variable");

const getOctokit = Effect.gen(function* () {
  const creds = yield* GitHubCredentials;
  return creds.octokit();
});

export const VariableProvider = () =>
  Provider.succeed(Variable, {
    // `(owner, repository, name)` is the GitHub-side identifier for a
    // repo variable. Mutating any of them isn't an in-place rename —
    // GitHub will refuse, so the engine must replace.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.name !== olds.name
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = yield* getOctokit;

      // Observe — `name` is the path identifier for repo variables; ask
      // GitHub directly for the live row. A 404 means it doesn't exist
      // (deleted out-of-band, or never created), so we converge by
      // creating it; otherwise we PATCH the value.
      const observed = yield* Effect.tryPromise({
        try: async () => {
          try {
            const { data } = await octokit.rest.actions.getRepoVariable({
              owner: news.owner,
              repo: news.repository,
              name: news.name,
            });
            return data;
          } catch (error: any) {
            if (error.status === 404) return undefined;
            throw error;
          }
        },
        catch: (e) => e as Error,
      });

      // Ensure — POST creates the variable. Tolerate a 422 race: another
      // caller (or a concurrent reconcile) may have created the variable
      // between our observe and ensure; in that case we fall through to
      // the sync step below to make the value match.
      if (observed === undefined) {
        const created = yield* Effect.tryPromise({
          try: async () => {
            try {
              await octokit.rest.actions.createRepoVariable({
                owner: news.owner,
                repo: news.repository,
                name: news.name,
                value: news.value,
              });
              return true as const;
            } catch (error: any) {
              // 422 = "variable already exists" race. Anything else is
              // a real error (auth, validation on name format, …).
              if (error.status === 422) return false as const;
              throw error;
            }
          },
          catch: (e) => e as Error,
        });
        if (created) {
          return { updatedAt: new Date().toISOString() };
        }
      }

      // Sync — PATCH the value when the observed cloud value drifted
      // from desired (or when we just lost the create race above). Skip
      // the API call on a no-op so the timestamp doesn't churn — this
      // keeps redeploys with the same props as a true no-op.
      if (observed === undefined || observed.value !== news.value) {
        yield* Effect.tryPromise(() =>
          octokit.rest.actions.updateRepoVariable({
            owner: news.owner,
            repo: news.repository,
            name: news.name,
            value: news.value,
          }),
        );
        return { updatedAt: new Date().toISOString() };
      }
      // Observed value already matches — preserve prior timestamp so
      // a redeploy with unchanged props is a true no-op for downstream
      // consumers reading `updatedAt`.
      return {
        updatedAt: output?.updatedAt ?? new Date().toISOString(),
      };
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* getOctokit;

      // Idempotent delete: 404 = already gone (deleted out-of-band or
      // never created), which is the desired terminal state.
      yield* Effect.tryPromise(async () => {
        try {
          await octokit.rest.actions.deleteRepoVariable({
            owner: olds.owner,
            repo: olds.repository,
            name: olds.name,
          });
        } catch (error: any) {
          if (error.status !== 404) {
            throw error;
          }
        }
      });
    }),
  });
