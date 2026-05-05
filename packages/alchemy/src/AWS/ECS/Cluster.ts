import * as ecs from "@distilled.cloud/aws/ecs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type ClusterName = string;
export type ClusterArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:cluster/${ClusterName}`;

export interface ClusterProps {
  /**
   * Cluster name. If omitted, a unique name is generated.
   */
  clusterName?: string;
  /**
   * ECS cluster settings such as container insights.
   */
  settings?: ecs.ClusterSetting[];
  /**
   * Cluster configuration such as execute command logging.
   */
  configuration?: ecs.ClusterConfiguration;
  /**
   * Optional capacity providers associated with the cluster.
   */
  capacityProviders?: string[];
  /**
   * Default capacity provider strategy for the cluster.
   */
  defaultCapacityProviderStrategy?: ecs.CapacityProviderStrategyItem[];
  /**
   * Optional Service Connect defaults for the cluster.
   */
  serviceConnectDefaults?: ecs.ClusterServiceConnectDefaultsRequest;
  /**
   * User-defined tags to apply to the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.ECS.Cluster",
  ClusterProps,
  {
    clusterArn: ClusterArn;
    clusterName: ClusterName;
    status: string;
    settings: ecs.ClusterSetting[];
    configuration?: ecs.ClusterConfiguration;
    capacityProviders: string[];
    defaultCapacityProviderStrategy: ecs.CapacityProviderStrategyItem[];
    serviceConnectDefaults?: ecs.ClusterServiceConnectDefaultsRequest;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECS cluster for running tasks and services.
 *
 * @section Creating Clusters
 * @example Default Cluster
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {});
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.ECS.Cluster");

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const toEcsTags = (tags: Record<string, string>): ecs.Tag[] =>
        Object.entries(tags).map(([key, value]) => ({
          key,
          value,
        }));

      const toClusterName = (
        id: string,
        props: { clusterName?: string } = {},
      ) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      // `UpdateInProgressException` is raised when ECS is still applying a
      // prior cluster mutation. It is transient — back off and retry on a
      // bounded schedule so we don't loop forever if the cluster is wedged.
      const retryOnUpdateInProgress = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.retry({
            while: (e) =>
              (e as { _tag?: string })._tag === "UpdateInProgressException",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(30)),
            ),
          }),
        );

      const applyCapacityProviders = Effect.fn(function* ({
        cluster,
        capacityProviders,
        defaultCapacityProviderStrategy,
      }: {
        cluster: string;
        capacityProviders?: string[];
        defaultCapacityProviderStrategy?: ecs.CapacityProviderStrategyItem[];
      }) {
        if (
          capacityProviders !== undefined ||
          defaultCapacityProviderStrategy !== undefined
        ) {
          yield* retryOnUpdateInProgress(
            ecs.putClusterCapacityProviders({
              cluster,
              capacityProviders: capacityProviders ?? [],
              defaultCapacityProviderStrategy:
                defaultCapacityProviderStrategy ?? [],
            }),
          );
        }
      });

      return {
        stables: ["clusterArn", "clusterName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toClusterName(id, olds ?? {})) !==
            (yield* toClusterName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterName =
            output?.clusterName ?? (yield* toClusterName(id, olds ?? {}));
          const described = yield* ecs.describeClusters({
            clusters: [output?.clusterArn ?? clusterName],
            include: ["SETTINGS", "TAGS", "CONFIGURATIONS"],
          });
          // ECS keeps INACTIVE clusters in describeClusters for ~1h after
          // delete; treat them as gone so the reconciler recreates rather
          // than trying to update a tombstone.
          const cluster = described.clusters?.find(
            (c) =>
              c.clusterName === clusterName &&
              c.status !== "INACTIVE" &&
              c.status !== "DEPROVISIONING",
          );
          if (!cluster?.clusterArn) {
            return undefined;
          }
          const observedTags = Object.fromEntries(
            (cluster.tags ?? [])
              .filter(
                (t): t is { key: string; value: string } =>
                  typeof t.key === "string" && typeof t.value === "string",
              )
              .map((t) => [t.key, t.value]),
          );
          const attrs = {
            clusterArn: cluster.clusterArn as ClusterArn,
            clusterName: cluster.clusterName!,
            status: cluster.status ?? "ACTIVE",
            settings: cluster.settings ?? [],
            configuration: cluster.configuration,
            capacityProviders: cluster.capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              cluster.defaultCapacityProviderStrategy ?? [],
            serviceConnectDefaults: cluster.serviceConnectDefaults?.namespace
              ? { namespace: cluster.serviceConnectDefaults.namespace }
              : undefined,
            tags: observedTags,
          };
          // Foreign clusters (no alchemy tags) require `--adopt` / `adopt(true)`
          // before the engine will take them over.
          return (yield* hasAlchemyTags(id, observedTags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const clusterName = yield* toClusterName(id, news);
          const clusterArn =
            `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}` as ClusterArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live cloud state. INACTIVE / DEPROVISIONING
          // clusters linger for ~1h after delete; treat them as gone so we
          // recreate rather than trying to update a tombstone.
          const observe = ecs
            .describeClusters({
              clusters: [clusterArn],
              include: ["SETTINGS", "TAGS", "CONFIGURATIONS"],
            })
            .pipe(
              Effect.map(
                (r) =>
                  r.clusters?.find(
                    (c) =>
                      c.clusterName === clusterName &&
                      c.status !== "INACTIVE" &&
                      c.status !== "DEPROVISIONING",
                  ),
              ),
            );
          let cluster = yield* observe;

          // Ensure — create if missing. `createCluster` does not raise on a
          // pre-existing cluster of the same name; it returns the existing
          // resource. We always sync below regardless.
          if (!cluster?.clusterArn) {
            yield* ecs.createCluster({
              clusterName,
              settings: news.settings,
              configuration: news.configuration,
              serviceConnectDefaults: news.serviceConnectDefaults,
              tags: toEcsTags(desiredTags),
            });
            // Re-read so the tag-diff baseline reflects what's actually on
            // the cluster (createCluster's response doesn't echo tags).
            cluster = yield* observe;
          }

          // Sync cluster config — call updateCluster to converge settings,
          // configuration, and serviceConnectDefaults to desired state.
          // ECS may surface `UpdateInProgressException` if a previous update
          // hasn't fully propagated; back off and retry.
          yield* retryOnUpdateInProgress(
            ecs.updateCluster({
              cluster: clusterArn,
              settings: news.settings,
              configuration: news.configuration,
              serviceConnectDefaults: news.serviceConnectDefaults,
            }),
          );

          // Sync capacity providers — observed ↔ desired.
          yield* applyCapacityProviders({
            cluster: clusterArn,
            capacityProviders: news.capacityProviders,
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy,
          });

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = Object.fromEntries(
            (cluster?.tags ?? [])
              .filter(
                (t): t is { key: string; value: string } =>
                  typeof t.key === "string" && typeof t.value === "string",
              )
              .map((t) => [t.key, t.value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ecs.tagResource({
              resourceArn: clusterArn,
              tags: upsert.map((tag) => ({ key: tag.Key, value: tag.Value })),
            });
          }
          if (removed.length > 0) {
            yield* ecs.untagResource({
              resourceArn: clusterArn,
              tagKeys: removed,
            });
          }

          yield* session.note(clusterArn);
          return {
            clusterArn,
            clusterName,
            status: cluster?.status ?? "ACTIVE",
            settings: news.settings ?? [],
            configuration: news.configuration,
            capacityProviders: news.capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy ?? [],
            serviceConnectDefaults: news.serviceConnectDefaults,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // ECS rejects delete while a prior mutation is in flight; retry
          // briefly. `ClusterContainsServicesException` /
          // `ClusterContainsTasksException` /
          // `ClusterContainsContainerInstancesException` /
          // `ClusterContainsCapacityProviderException` mean the cluster
          // still has dependents — surface those so the engine reports a
          // dependency violation rather than pretending we deleted.
          // `ClusterNotFoundException` is success (already gone).
          yield* retryOnUpdateInProgress(
            ecs.deleteCluster({
              cluster: output.clusterArn,
            }),
          ).pipe(
            Effect.catchTag("ClusterNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
