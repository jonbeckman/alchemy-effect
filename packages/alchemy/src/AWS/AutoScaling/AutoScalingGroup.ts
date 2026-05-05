import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type {
  LaunchTemplateId,
  LaunchTemplateName,
  LaunchTemplate as LaunchTemplateResource,
} from "./LaunchTemplate.ts";

export type AutoScalingGroupName = string;

class AutoScalingGroupNotReadyAfterCreate extends Data.TaggedError(
  "AutoScalingGroupNotReadyAfterCreate",
) {}

class AutoScalingGroupStillExists extends Data.TaggedError(
  "AutoScalingGroupStillExists",
) {}

export interface LaunchTemplateReference {
  launchTemplateId?: Input<LaunchTemplateId>;
  launchTemplateName?: Input<LaunchTemplateName>;
  version?: Input<string | number>;
}

export interface AutoScalingGroupProps {
  /**
   * Auto Scaling Group name. If omitted, a deterministic name is generated.
   */
  autoScalingGroupName?: string;
  /**
   * Launch template used for instances in the fleet.
   */
  launchTemplate: Input<LaunchTemplateReference> | LaunchTemplateResource;
  /**
   * Subnets to place the fleet into.
   */
  subnetIds: Input<SubnetId[]>;
  /**
   * Minimum number of instances.
   */
  minSize: number;
  /**
   * Maximum number of instances.
   */
  maxSize: number;
  /**
   * Desired number of instances.
   * @default minSize
   */
  desiredCapacity?: number;
  /**
   * Target groups to attach to the fleet.
   */
  targetGroupArns?: Input<string[]>;
  /**
   * Health check type.
   * @default "ELB" when target groups are present, otherwise "EC2"
   */
  healthCheckType?: "EC2" | "ELB";
  /**
   * Grace period in seconds before health checks start.
   */
  healthCheckGracePeriod?: number;
  /**
   * Default cooldown in seconds.
   */
  defaultCooldown?: number;
  /**
   * Termination policies for scale-in.
   */
  terminationPolicies?: string[];
  /**
   * Tags to apply to the Auto Scaling Group itself.
   */
  tags?: Record<string, string>;
}

export interface AutoScalingGroup extends Resource<
  "AWS.AutoScaling.AutoScalingGroup",
  AutoScalingGroupProps,
  {
    autoScalingGroupArn: string;
    autoScalingGroupName: AutoScalingGroupName;
    launchTemplateId?: string;
    launchTemplateName?: string;
    launchTemplateVersion?: string;
    subnetIds: string[];
    minSize: number;
    maxSize: number;
    desiredCapacity: number;
    targetGroupArns: string[];
    healthCheckType?: string;
    healthCheckGracePeriod?: number;
    defaultCooldown?: number;
    terminationPolicies?: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An EC2 Auto Scaling Group that manages a fleet of instances from a launch
 * template and can register that fleet with one or more load balancer target
 * groups.
 */
export const AutoScalingGroup = Resource<AutoScalingGroup>(
  "AWS.AutoScaling.AutoScalingGroup",
);

const isLaunchTemplateResource = (
  value: unknown,
): value is LaunchTemplateResource =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as { Type?: string }).Type === "AWS.AutoScaling.LaunchTemplate";

const sortStrings = (values: readonly string[] = []) =>
  [...values].sort((a, b) => a.localeCompare(b));

export const AutoScalingGroupProvider = () =>
  Provider.effect(
    AutoScalingGroup,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { autoScalingGroupName?: string } = {},
      ) =>
        props.autoScalingGroupName
          ? Effect.succeed(props.autoScalingGroupName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const toLaunchTemplateSpec = (
        input: AutoScalingGroupProps["launchTemplate"],
      ) => {
        const spec = isLaunchTemplateResource(input)
          ? {
              launchTemplateId: input.launchTemplateId,
              launchTemplateName: input.launchTemplateName,
              version: input.defaultVersionNumber,
            }
          : ((input ?? {}) as LaunchTemplateReference);

        return {
          LaunchTemplateId: spec.launchTemplateId as string | undefined,
          LaunchTemplateName: spec.launchTemplateName as string | undefined,
          Version:
            spec.version === undefined ? "$Default" : String(spec.version),
        };
      };

      const describeGroup = (autoScalingGroupName: string) =>
        autoscaling
          .describeAutoScalingGroups({
            AutoScalingGroupNames: [autoScalingGroupName],
          })
          .pipe(Effect.map((result) => result.AutoScalingGroups?.[0]));

      const toTags = (name: string, tags: Record<string, string>) =>
        Object.entries(tags).map(([Key, Value]) => ({
          ResourceId: name,
          ResourceType: "auto-scaling-group",
          Key,
          Value,
          PropagateAtLaunch: false,
        }));

      const syncTargetGroups = Effect.fn(function* ({
        autoScalingGroupName,
        oldTargetGroupArns,
        newTargetGroupArns,
      }: {
        autoScalingGroupName: string;
        oldTargetGroupArns: string[];
        newTargetGroupArns: string[];
      }) {
        const oldSet = new Set(oldTargetGroupArns);
        const newSet = new Set(newTargetGroupArns);

        const detached = oldTargetGroupArns.filter((arn) => !newSet.has(arn));
        const attached = newTargetGroupArns.filter((arn) => !oldSet.has(arn));

        if (detached.length > 0) {
          yield* autoscaling
            .detachLoadBalancerTargetGroups({
              AutoScalingGroupName: autoScalingGroupName,
              TargetGroupARNs: detached,
            } as any)
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "ResourceContentionFault",
                schedule: Schedule.fixed("2 seconds").pipe(
                  Schedule.both(Schedule.recurs(15)),
                ),
              }),
            );
        }

        if (attached.length > 0) {
          yield* autoscaling
            .attachLoadBalancerTargetGroups({
              AutoScalingGroupName: autoScalingGroupName,
              TargetGroupARNs: attached,
            } as any)
            .pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "ResourceContentionFault" ||
                  e._tag === "InstanceRefreshInProgressFault",
                schedule: Schedule.fixed("2 seconds").pipe(
                  Schedule.both(Schedule.recurs(15)),
                ),
              }),
            );
        }
      });

      const syncTags = Effect.fn(function* ({
        autoScalingGroupName,
        oldTags,
        newTags,
      }: {
        autoScalingGroupName: string;
        oldTags: Record<string, string>;
        newTags: Record<string, string>;
      }) {
        const { removed, upsert } = diffTags(oldTags, newTags);

        if (removed.length > 0) {
          yield* autoscaling.deleteTags({
            Tags: removed.map((Key) => ({
              ResourceId: autoScalingGroupName,
              ResourceType: "auto-scaling-group",
              Key,
            })),
          } as any);
        }

        if (upsert.length > 0) {
          yield* autoscaling.createOrUpdateTags({
            Tags: upsert.map(({ Key, Value }) => ({
              ResourceId: autoScalingGroupName,
              ResourceType: "auto-scaling-group",
              Key,
              Value,
              PropagateAtLaunch: false,
            })),
          } as any);
        }
      });

      const toAttributes = (
        group: autoscaling.AutoScalingGroup,
      ): AutoScalingGroup["Attributes"] => ({
        autoScalingGroupArn: group.AutoScalingGroupARN!,
        autoScalingGroupName: group.AutoScalingGroupName!,
        launchTemplateId: group.LaunchTemplate?.LaunchTemplateId,
        launchTemplateName: group.LaunchTemplate?.LaunchTemplateName,
        launchTemplateVersion: group.LaunchTemplate?.Version,
        subnetIds: String(group.VPCZoneIdentifier ?? "")
          .split(",")
          .filter(Boolean),
        minSize: group.MinSize ?? 0,
        maxSize: group.MaxSize ?? 0,
        desiredCapacity: group.DesiredCapacity ?? 0,
        targetGroupArns: sortStrings(group.TargetGroupARNs ?? []),
        healthCheckType: group.HealthCheckType,
        healthCheckGracePeriod: group.HealthCheckGracePeriod,
        defaultCooldown: group.DefaultCooldown,
        terminationPolicies: group.TerminationPolicies ?? [],
        tags: Object.fromEntries(
          (group.Tags ?? [])
            .filter((tag): tag is { Key: string; Value: string } =>
              Boolean(tag.Key && tag.Value !== undefined),
            )
            .map((tag) => [tag.Key, tag.Value]),
        ),
      });

      return {
        stables: ["autoScalingGroupArn", "autoScalingGroupName"],
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace", deleteFirst: true } as const;
          }

          if (!deepEqual(olds, news)) {
            return {
              action: "update",
              stables: ["autoScalingGroupArn", "autoScalingGroupName"],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.autoScalingGroupName ?? (yield* toName(id, olds ?? {}));
          const group = yield* describeGroup(name);
          if (!group) return undefined;
          const attrs = toAttributes(group);
          // Mark the resource as Unowned when alchemy tags are missing so
          // the engine can gate adoption behind `adopt(true)`.
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ?? (yield* toName(id, news));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const targetGroupArns = sortStrings(
            (news.targetGroupArns ?? []) as string[],
          );
          const launchTemplate = toLaunchTemplateSpec(news.launchTemplate);
          const healthCheckType =
            news.healthCheckType ??
            (targetGroupArns.length > 0 ? "ELB" : "EC2");

          // Observe — fetch live state. `describeAutoScalingGroups` returns
          // an empty list when the ASG is missing; we never trust `output`
          // alone since the ASG may have been deleted out of band.
          let existing = yield* describeGroup(autoScalingGroupName);

          // Ensure — create the ASG if missing. `createAutoScalingGroup`
          // raises `AlreadyExistsFault` on a race; we fall through to the
          // sync path on that case.
          if (!existing) {
            yield* autoscaling
              .createAutoScalingGroup({
                AutoScalingGroupName: autoScalingGroupName,
                MinSize: news.minSize,
                MaxSize: news.maxSize,
                DesiredCapacity: news.desiredCapacity ?? news.minSize,
                LaunchTemplate: launchTemplate,
                VPCZoneIdentifier: (news.subnetIds as string[]).join(","),
                TargetGroupARNs: targetGroupArns,
                HealthCheckType: healthCheckType,
                HealthCheckGracePeriod: news.healthCheckGracePeriod,
                DefaultCooldown: news.defaultCooldown,
                TerminationPolicies: news.terminationPolicies,
                Tags: toTags(autoScalingGroupName, desiredTags),
              } as any)
              .pipe(
                // Race: a peer reconciler created the ASG concurrently, or
                // a previous reconciler crashed after Create succeeded but
                // before persisting state. Fall through to the sync path.
                Effect.catchTag("AlreadyExistsFault", () => Effect.void),
              );

            // Wait for `describeAutoScalingGroups` to return the new ASG.
            // The ASG control plane is eventually consistent — only retry
            // on the explicit "still missing" case. Other errors propagate.
            existing = yield* describeGroup(autoScalingGroupName).pipe(
              Effect.flatMap((group) =>
                group
                  ? Effect.succeed(group)
                  : Effect.fail(new AutoScalingGroupNotReadyAfterCreate()),
              ),
              Effect.retry({
                while: (e) =>
                  e._tag === "AutoScalingGroupNotReadyAfterCreate",
                schedule: Schedule.recurs(8).pipe(
                  Schedule.both(Schedule.exponential("250 millis")),
                ),
              }),
            );
          }

          // Sync core ASG configuration — `updateAutoScalingGroup`
          // overwrites min/max/desired/template/subnets/health-check
          // settings in one call. AWS rejects concurrent updates with
          // `ScalingActivityInProgressFault` (transient — a scale-in or
          // scale-out is mid-flight) so we retry it. We never call this
          // unconditionally on a freshly-created ASG that already lands
          // with the right config.
          if (existing) {
            yield* autoscaling
              .updateAutoScalingGroup({
                AutoScalingGroupName: autoScalingGroupName,
                MinSize: news.minSize,
                MaxSize: news.maxSize,
                DesiredCapacity: news.desiredCapacity ?? news.minSize,
                LaunchTemplate: launchTemplate,
                VPCZoneIdentifier: (news.subnetIds as string[]).join(","),
                HealthCheckType: healthCheckType,
                HealthCheckGracePeriod: news.healthCheckGracePeriod,
                DefaultCooldown: news.defaultCooldown,
                TerminationPolicies: news.terminationPolicies,
              } as any)
              .pipe(
                Effect.retry({
                  while: (e) =>
                    e._tag === "ScalingActivityInProgressFault" ||
                    e._tag === "ResourceContentionFault",
                  schedule: Schedule.fixed("2 seconds").pipe(
                    Schedule.both(Schedule.recurs(15)),
                  ),
                }),
              );
          }

          // Sync target groups — observed cloud attachments vs desired.
          const observedAttrs = toAttributes(existing);
          yield* syncTargetGroups({
            autoScalingGroupName,
            oldTargetGroupArns: sortStrings(existing.TargetGroupARNs ?? []),
            newTargetGroupArns: targetGroupArns,
          });

          // Sync tags — observed cloud tags vs desired. Adoption brings
          // tags through `existing.Tags`; we converge regardless of what
          // was there before.
          yield* syncTags({
            autoScalingGroupName,
            oldTags: observedAttrs.tags,
            newTags: desiredTags,
          });

          // Re-read final state so attributes reflect post-sync cloud
          // state.
          const group = yield* describeGroup(autoScalingGroupName).pipe(
            Effect.filterOrFail(
              Boolean,
              () =>
                new Error(
                  `Auto Scaling Group '${autoScalingGroupName}' was not readable after reconcile`,
                ),
            ),
          );
          yield* session.note(autoScalingGroupName);
          return toAttributes(group);
        }),
        delete: Effect.fn(function* ({ output }) {
          const existing = yield* describeGroup(output.autoScalingGroupName);
          if (!existing) {
            return;
          }

          // `ForceDelete=true` lets AWS terminate any in-flight instances
          // instead of refusing the call. `ScalingActivityInProgressFault`
          // is transient — a scale activity raced our delete; retry.
          yield* autoscaling
            .deleteAutoScalingGroup({
              AutoScalingGroupName: output.autoScalingGroupName,
              ForceDelete: true,
            } as any)
            .pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "ScalingActivityInProgressFault" ||
                  e._tag === "ResourceInUseFault" ||
                  e._tag === "ResourceContentionFault",
                schedule: Schedule.fixed("2 seconds").pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
              }),
            );

          // Wait for the ASG to disappear from `describeAutoScalingGroups`
          // — deletion is asynchronous (instances drain before the group
          // record is removed). Bound the wait so we don't loop forever.
          yield* describeGroup(output.autoScalingGroupName).pipe(
            Effect.flatMap((group) =>
              group
                ? Effect.fail(new AutoScalingGroupStillExists())
                : Effect.void,
            ),
            Effect.retry({
              while: (e) => e._tag === "AutoScalingGroupStillExists",
              schedule: Schedule.fixed("2 seconds").pipe(
                Schedule.both(Schedule.recurs(60)),
              ),
            }),
          );
        }),
      };
    }),
  );
