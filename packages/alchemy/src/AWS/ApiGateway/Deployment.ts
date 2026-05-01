import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface DeploymentProps {
  restApiId: Input<string>;
  description?: string;
  stageName?: string;
  stageDescription?: string;
  cacheClusterEnabled?: boolean;
  cacheClusterSize?: ag.CacheClusterSize;
  variables?: { [key: string]: string | undefined };
  canarySettings?: ag.DeploymentCanarySettings;
  tracingEnabled?: boolean;
  /**
   * Opaque key/value map; when any value changes, a replacement deployment is planned.
   */
  triggers?: Record<string, string>;
}

export interface Deployment extends Resource<
  "AWS.ApiGateway.Deployment",
  DeploymentProps,
  {
    deploymentId: string;
    restApiId: string;
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An API Gateway deployment snapshot for a REST API.
 *
 * @section Deployments
 * @example Create deployment
 * ```typescript
 * const deployment = yield* ApiGateway.Deployment("Release", {
 *   restApiId: api.restApiId,
 *   description: "v1",
 * });
 * ```
 */
const DeploymentResource = Resource<Deployment>("AWS.ApiGateway.Deployment");

export { DeploymentResource as Deployment };

const embedTriggers = (
  description: string | undefined,
  triggers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    if (!triggers || Object.keys(triggers).length === 0) {
      return description;
    }
    const fp = yield* Effect.sync(() =>
      createHash("sha256")
        .update(JSON.stringify(triggers))
        .digest("hex")
        .slice(0, 24),
    );
    const suffix = `@alchemy:triggers:${fp}`;
    return description ? `${description}\n${suffix}` : suffix;
  });

export const DeploymentProvider = () =>
  Provider.effect(
    DeploymentResource,
    Effect.gen(function* () {
      return {
        stables: ["deploymentId", "restApiId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<DeploymentProps>;
          const oldsP = olds as Input.ResolveProps<DeploymentProps>;
          if (news.restApiId !== oldsP.restApiId) {
            return { action: "replace" } as const;
          }
          if (!deepEqual(news.triggers, oldsP.triggers)) {
            return { action: "replace" } as const;
          }
          if (
            news.stageName !== oldsP.stageName ||
            news.stageDescription !== oldsP.stageDescription ||
            news.cacheClusterEnabled !== oldsP.cacheClusterEnabled ||
            news.cacheClusterSize !== oldsP.cacheClusterSize ||
            !deepEqual(news.variables, oldsP.variables) ||
            !deepEqual(news.canarySettings, oldsP.canarySettings) ||
            news.tracingEnabled !== oldsP.tracingEnabled
          ) {
            return { action: "replace" } as const;
          }
          if (news.description !== oldsP.description) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.deploymentId) return undefined;
          const d = yield* ag
            .getDeployment({
              restApiId: output.restApiId,
              deploymentId: output.deploymentId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!d?.id) return undefined;
          return {
            deploymentId: d.id,
            restApiId: output.restApiId,
            description: d.description,
          };
        }),
        create: Effect.fn(function* ({ news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Deployment props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<DeploymentProps>;
          const description = yield* embedTriggers(
            news.description,
            news.triggers,
          );
          const d = yield* ag.createDeployment({
            restApiId: news.restApiId as string,
            stageName: news.stageName,
            stageDescription: news.stageDescription,
            description,
            cacheClusterEnabled: news.cacheClusterEnabled,
            cacheClusterSize: news.cacheClusterSize,
            variables: news.variables,
            canarySettings: news.canarySettings,
            tracingEnabled: news.tracingEnabled,
          });
          if (!d.id) return yield* Effect.die("createDeployment missing id");
          yield* session.note(`Created deployment ${d.id}`);
          return {
            deploymentId: d.id,
            restApiId: news.restApiId as string,
            description: d.description,
          };
        }),
        update: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Deployment props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<DeploymentProps>;
          const description = yield* embedTriggers(
            news.description,
            news.triggers,
          );
          if (description !== output.description) {
            yield* ag.updateDeployment({
              restApiId: output.restApiId,
              deploymentId: output.deploymentId,
              patchOperations: description
                ? [{ op: "replace", path: "/description", value: description }]
                : [{ op: "remove", path: "/description" }],
            });
          }
          yield* session.note(`Updated deployment ${output.deploymentId}`);
          const d = yield* ag.getDeployment({
            restApiId: output.restApiId,
            deploymentId: output.deploymentId,
          });
          return {
            deploymentId: output.deploymentId,
            restApiId: output.restApiId,
            description: d?.description,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteDeployment({
              restApiId: output.restApiId,
              deploymentId: output.deploymentId,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted deployment ${output.deploymentId}`);
        }),
      };
    }),
  );
