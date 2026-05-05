import * as rds from "@distilled.cloud/aws/rds";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBInstanceProps {
  /**
   * Instance identifier. If omitted, Alchemy generates one.
   */
  dbInstanceIdentifier?: string;
  /**
   * Aurora cluster the instance belongs to.
   */
  dbClusterIdentifier?: string;
  /**
   * Instance class such as `db.serverless`.
   */
  dbInstanceClass: string;
  /**
   * Database engine, usually matching the cluster engine.
   */
  engine: string;
  /**
   * Optional engine version.
   */
  engineVersion?: string;
  /**
   * Optional DB subnet group.
   */
  dbSubnetGroupName?: string;
  /**
   * Optional DB parameter group.
   */
  dbParameterGroupName?: string;
  /**
   * VPC security groups attached to the instance.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Whether the instance is publicly reachable.
   */
  publiclyAccessible?: boolean;
  /**
   * Promotion tier inside the cluster.
   */
  promotionTier?: number;
  /**
   * Auto minor version upgrades.
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Copy tags to snapshots.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * Allocated storage in GiB. Only used for non-Aurora instances —
   * Aurora cluster members ignore this and consume the cluster volume.
   */
  allocatedStorage?: number;
  /**
   * Daily backup retention window in days. Aurora cluster members
   * inherit this from the cluster, so set it on the cluster instead.
   */
  backupRetentionPeriod?: number;
  /**
   * Preferred backup window in `hh24:mi-hh24:mi` UTC format.
   */
  preferredBackupWindow?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBInstance extends Resource<
  "AWS.RDS.DBInstance",
  DBInstanceProps,
  {
    dbInstanceIdentifier: string;
    dbInstanceArn: string;
    dbClusterIdentifier: string | undefined;
    endpointAddress: string | undefined;
    endpointPort: number | undefined;
    dbInstanceClass: string | undefined;
    engine: string | undefined;
    engineVersion: string | undefined;
    status: string | undefined;
    promotionTier: number | undefined;
    publiclyAccessible: boolean | undefined;
    allocatedStorage: number | undefined;
    backupRetentionPeriod: number | undefined;
    preferredBackupWindow: string | undefined;
    dbSubnetGroupName: string | undefined;
    dbParameterGroupNames: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Aurora cluster instance.
 */
export const DBInstance = Resource<DBInstance>("AWS.RDS.DBInstance");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = ({
  instance,
  tags,
}: {
  instance: rds.DBInstance;
  tags: Record<string, string>;
}): DBInstance["Attributes"] => ({
  dbInstanceIdentifier: instance.DBInstanceIdentifier ?? "",
  dbInstanceArn: instance.DBInstanceArn ?? "",
  dbClusterIdentifier: instance.DBClusterIdentifier,
  endpointAddress: instance.Endpoint?.Address,
  endpointPort: instance.Endpoint?.Port,
  dbInstanceClass: instance.DBInstanceClass,
  engine: instance.Engine,
  engineVersion: instance.EngineVersion,
  status: instance.DBInstanceStatus,
  promotionTier: instance.PromotionTier,
  publiclyAccessible: instance.PubliclyAccessible,
  allocatedStorage: instance.AllocatedStorage,
  backupRetentionPeriod: instance.BackupRetentionPeriod,
  preferredBackupWindow: instance.PreferredBackupWindow,
  dbSubnetGroupName: instance.DBSubnetGroup?.DBSubnetGroupName,
  dbParameterGroupNames: (instance.DBParameterGroups ?? []).flatMap((group) =>
    group.DBParameterGroupName ? [group.DBParameterGroupName] : [],
  ),
  tags,
});

// Status snapshot used to drive `waitForStableState`. The reconciler
// should only mutate or read attributes off an instance that has reached
// one of these terminal-for-our-purposes states; otherwise control-plane
// calls fail with `InvalidDBInstanceStateFault`.
const isStableInstanceStatus = (status: string | undefined): boolean =>
  status === "available" ||
  status === "stopped" ||
  status === "incompatible-network" ||
  status === "incompatible-parameters" ||
  status === "incompatible-restore" ||
  status === "incompatible-credentials" ||
  status === "failed";

class DBInstanceUnreadable extends Data.TaggedError("DBInstanceUnreadable")<{
  identifier: string;
  phase: "post-create" | "post-modify" | "wait-stable";
}> {}

class DBInstanceNotStable extends Data.TaggedError("DBInstanceNotStable")<{
  identifier: string;
  status: string | undefined;
}> {}

class DBInstanceStillDeleting extends Data.TaggedError(
  "DBInstanceStillDeleting",
)<{
  identifier: string;
}> {}

export const DBInstanceProvider = () =>
  Provider.effect(
    DBInstance,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBInstanceProps) =>
        props.dbInstanceIdentifier
          ? Effect.succeed(props.dbInstanceIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readInstance = Effect.fn(function* (instanceId: string) {
        const response = yield* rds
          .describeDBInstances({
            DBInstanceIdentifier: instanceId,
          })
          .pipe(
            Effect.catchTag("DBInstanceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBInstances?.[0];
      });

      // RDS create / modify cycles are 5-15 minutes. Poll every 10s for
      // up to ~25 minutes — long enough for `db.t3.micro` cluster members
      // and standalone instances, while still bounded so a stuck instance
      // surfaces instead of hanging forever.
      const stableStatePolicy = Schedule.fixed("10 seconds").pipe(
        Schedule.both(Schedule.recurs(150)),
      );

      // Modify-time control-plane retries: AWS returns
      // `InvalidDBInstanceStateFault` when an instance is mid-transition
      // (e.g. another modify is still applying). Ride that out with a
      // short bounded retry so we don't surface a transient race.
      const controlPlaneRetryPolicy = Schedule.exponential("1 second").pipe(
        Schedule.both(Schedule.recurs(20)),
      );

      const isControlPlaneRetryable = (error: { _tag?: string }) =>
        error._tag === "InvalidDBInstanceStateFault" ||
        error._tag === "DBInstanceNotFoundFault";

      const retryControlPlane = <A, E extends { _tag?: string }, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.retry({
            while: isControlPlaneRetryable,
            schedule: controlPlaneRetryPolicy,
          }),
        );

      const waitForStableInstance = Effect.fn(function* (
        instanceId: string,
        session: { note: (msg: string) => Effect.Effect<void> },
      ) {
        return yield* Effect.gen(function* () {
          const instance = yield* readInstance(instanceId);
          if (!instance?.DBInstanceArn) {
            yield* session.note(
              `DB instance ${instanceId}: waiting for stable state, observed missing`,
            );
            return yield* Effect.fail(
              new DBInstanceNotStable({
                identifier: instanceId,
                status: instance?.DBInstanceStatus,
              }),
            );
          }
          if (!isStableInstanceStatus(instance.DBInstanceStatus)) {
            yield* session.note(
              `DB instance ${instanceId}: waiting for stable state, observed ${instance.DBInstanceStatus ?? "UNKNOWN"}`,
            );
            return yield* Effect.fail(
              new DBInstanceNotStable({
                identifier: instanceId,
                status: instance.DBInstanceStatus,
              }),
            );
          }
          return instance;
        }).pipe(
          Effect.retry({
            while: (e) =>
              (e as { _tag?: string })._tag === "DBInstanceNotStable",
            schedule: stableStatePolicy,
          }),
        );
      });

      const waitForInstanceDeleted = Effect.fn(function* (instanceId: string) {
        return yield* readInstance(instanceId).pipe(
          Effect.flatMap((instance) =>
            instance ? Effect.fail(new DBInstanceStillDeleting({
              identifier: instanceId,
            })) : Effect.void,
          ),
          Effect.retry({
            while: (e) => e._tag === "DBInstanceStillDeleting",
            schedule: stableStatePolicy,
          }),
        );
      });

      // Compute the modify payload by diffing observed → desired. RDS
      // accepts a partial modify, so omitting fields whose desired value
      // matches observed avoids needlessly bumping `PendingModifiedValues`
      // and accidentally re-applying a stale value the user fixed
      // out-of-band. Returns `undefined` when nothing has drifted, which
      // signals the caller to skip `modifyDBInstance` entirely.
      const computeModifyPayload = (
        observed: rds.DBInstance,
        news: DBInstanceProps,
      ): rds.ModifyDBInstanceMessage | undefined => {
        const payload: rds.ModifyDBInstanceMessage = {
          DBInstanceIdentifier: observed.DBInstanceIdentifier!,
          ApplyImmediately: true,
        };
        let dirty = false;
        const set = <K extends keyof rds.ModifyDBInstanceMessage>(
          key: K,
          value: rds.ModifyDBInstanceMessage[K],
        ) => {
          payload[key] = value;
          dirty = true;
        };
        if (
          news.dbInstanceClass !== undefined &&
          news.dbInstanceClass !== observed.DBInstanceClass
        ) {
          set("DBInstanceClass", news.dbInstanceClass);
        }
        if (
          news.engineVersion !== undefined &&
          news.engineVersion !== observed.EngineVersion
        ) {
          // EngineVersion changes are major — let AWS choose whether to
          // apply at maintenance window if not eligible for immediate.
          set("EngineVersion", news.engineVersion);
          set("AllowMajorVersionUpgrade", true);
        }
        if (news.dbParameterGroupName !== undefined) {
          const observedGroup =
            observed.DBParameterGroups?.[0]?.DBParameterGroupName;
          if (news.dbParameterGroupName !== observedGroup) {
            set("DBParameterGroupName", news.dbParameterGroupName);
          }
        }
        if (news.vpcSecurityGroupIds !== undefined) {
          const observedSGs = (observed.VpcSecurityGroups ?? [])
            .flatMap((sg) =>
              sg.VpcSecurityGroupId ? [sg.VpcSecurityGroupId] : [],
            )
            .sort();
          const desiredSGs = [...news.vpcSecurityGroupIds].sort();
          if (
            observedSGs.length !== desiredSGs.length ||
            observedSGs.some((id, i) => id !== desiredSGs[i])
          ) {
            set("VpcSecurityGroupIds", news.vpcSecurityGroupIds);
          }
        }
        if (
          news.publiclyAccessible !== undefined &&
          news.publiclyAccessible !== observed.PubliclyAccessible
        ) {
          set("PubliclyAccessible", news.publiclyAccessible);
        }
        if (
          news.promotionTier !== undefined &&
          news.promotionTier !== observed.PromotionTier
        ) {
          set("PromotionTier", news.promotionTier);
        }
        if (
          news.autoMinorVersionUpgrade !== undefined &&
          news.autoMinorVersionUpgrade !== observed.AutoMinorVersionUpgrade
        ) {
          set("AutoMinorVersionUpgrade", news.autoMinorVersionUpgrade);
        }
        if (
          news.copyTagsToSnapshot !== undefined &&
          news.copyTagsToSnapshot !== observed.CopyTagsToSnapshot
        ) {
          set("CopyTagsToSnapshot", news.copyTagsToSnapshot);
        }
        if (
          news.allocatedStorage !== undefined &&
          news.allocatedStorage !== observed.AllocatedStorage
        ) {
          set("AllocatedStorage", news.allocatedStorage);
        }
        if (
          news.backupRetentionPeriod !== undefined &&
          news.backupRetentionPeriod !== observed.BackupRetentionPeriod
        ) {
          set("BackupRetentionPeriod", news.backupRetentionPeriod);
        }
        if (
          news.preferredBackupWindow !== undefined &&
          news.preferredBackupWindow !== observed.PreferredBackupWindow
        ) {
          set("PreferredBackupWindow", news.preferredBackupWindow);
        }
        return dirty ? payload : undefined;
      };

      return {
        stables: ["dbInstanceArn", "dbInstanceIdentifier"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBInstanceProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbInstanceIdentifier ??
            (yield* toIdentifier(
              id,
              olds ?? { dbInstanceClass: "", engine: "" },
            ));
          const instance = yield* readInstance(identifier);
          if (!instance?.DBInstanceArn) {
            return undefined;
          }
          return toAttrs({ instance, tags: toTagRecord(instance.TagList) });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbInstanceIdentifier ?? (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live instance state.
          let observed = yield* readInstance(identifier);

          // Ensure — create if missing. Tolerate
          // `DBInstanceAlreadyExistsFault` as a race with a peer reconciler.
          if (!observed?.DBInstanceArn) {
            yield* rds
              .createDBInstance({
                DBInstanceIdentifier: identifier,
                DBClusterIdentifier: news.dbClusterIdentifier,
                DBInstanceClass: news.dbInstanceClass,
                Engine: news.engine,
                EngineVersion: news.engineVersion,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBParameterGroupName: news.dbParameterGroupName,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                PubliclyAccessible: news.publiclyAccessible,
                PromotionTier: news.promotionTier,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
                CopyTagsToSnapshot: news.copyTagsToSnapshot,
                AllocatedStorage: news.allocatedStorage,
                BackupRetentionPeriod: news.backupRetentionPeriod,
                PreferredBackupWindow: news.preferredBackupWindow,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "DBInstanceAlreadyExistsFault",
                  () => Effect.void,
                ),
              );

            observed = yield* waitForStableInstance(identifier, session);
            if (!observed?.DBInstanceArn) {
              return yield* Effect.fail(
                new DBInstanceUnreadable({
                  identifier,
                  phase: "post-create",
                }),
              );
            }
          } else {
            // We observed an existing instance. If it's mid-transition
            // (creating/modifying/backing-up/etc.), wait for a stable
            // status before issuing modify so we don't trip
            // `InvalidDBInstanceStateFault`.
            if (!isStableInstanceStatus(observed.DBInstanceStatus)) {
              yield* session.note(
                `DB instance ${identifier}: observed in ${observed.DBInstanceStatus ?? "UNKNOWN"} state, waiting for stable before sync`,
              );
              observed = yield* waitForStableInstance(identifier, session);
            }

            // Sync mutable instance config — only call modify when
            // observed config drifts from desired. Otherwise the call is
            // a no-op that still triggers a `modifying` transition.
            const modifyPayload = computeModifyPayload(observed, news);
            if (modifyPayload) {
              yield* retryControlPlane(rds.modifyDBInstance(modifyPayload));
              observed = yield* waitForStableInstance(identifier, session);
              if (!observed?.DBInstanceArn) {
                return yield* Effect.fail(
                  new DBInstanceUnreadable({
                    identifier,
                    phase: "post-modify",
                  }),
                );
              }
            }
          }

          const dbInstanceArn = observed.DBInstanceArn ?? "";

          // Sync tags — diff observed cloud tags against desired so
          // adoption (where the live tags may not match what we last
          // persisted) converges correctly.
          const observedTags = toTagRecord(observed.TagList);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbInstanceArn) {
            yield* retryControlPlane(
              rds.addTagsToResource({
                ResourceName: dbInstanceArn,
                Tags: upsert,
              }),
            );
          }
          if (removed.length > 0 && dbInstanceArn) {
            yield* retryControlPlane(
              rds.removeTagsFromResource({
                ResourceName: dbInstanceArn,
                TagKeys: removed,
              }),
            );
          }

          yield* session.note(dbInstanceArn || identifier);
          return toAttrs({ instance: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          // Tolerate concurrent or already-issued deletes by retrying
          // through `InvalidDBInstanceStateFault` (instance still
          // transitioning into a delete-eligible state) up to the same
          // bounded budget the reconciler uses.
          yield* rds
            .deleteDBInstance({
              DBInstanceIdentifier: output.dbInstanceIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "InvalidDBInstanceStateFault",
                schedule: controlPlaneRetryPolicy,
              }),
              Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
            );

          // Wait for the instance to actually leave RDS — otherwise a
          // subsequent reconcile (or a replace) races against the
          // `deleting` state and fails with InvalidDBInstanceState.
          yield* waitForInstanceDeleted(output.dbInstanceIdentifier);
        }),
      };
    }),
  );
