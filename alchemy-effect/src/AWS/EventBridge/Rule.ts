import type * as Effect from "effect/Effect";

import type * as eventbridge from "distilled-aws/eventbridge";
import type { Input } from "../../Input.ts";
import { Resource } from "../../Resource.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type {
  InputTransformer,
  KinesisParameters,
  RunCommandParameters,
  RunCommandTarget,
  NetworkConfiguration,
  AwsVpcConfiguration,
  CapacityProviderStrategyItem,
  PlacementConstraint,
  PlacementStrategy,
  SqsParameters,
  HttpParameters,
  RedshiftDataParameters,
  SageMakerPipelineParameters,
  SageMakerPipelineParameter,
  RetryPolicy,
  AppSyncParameters,
  LaunchType,
  AssignPublicIp,
  PlacementConstraintType,
  PlacementStrategyType,
  PropagateTags,
  RuleState,
} from "distilled-aws/eventbridge";

export interface RuleTarget {
  /** Unique identifier for this target within the rule. */
  Id: string;
  /** ARN of the target resource. */
  Arn: Input<string>;
  /** ARN of the IAM role to use for this target when the rule is triggered. */
  RoleArn?: Input<string>;
  /** Valid JSON text passed to the target. Mutually exclusive with InputPath and InputTransformer. */
  Input?: string;
  /** JSONPath expression to extract from the event and send to the target. Mutually exclusive with Input and InputTransformer. */
  InputPath?: string;
  /** Settings to transform input before sending to the target. Mutually exclusive with Input and InputPath. */
  InputTransformer?: eventbridge.InputTransformer;
  /** Settings for a Kinesis Data Stream target. */
  KinesisParameters?: eventbridge.KinesisParameters;
  /** Parameters for Systems Manager Run Command targets. */
  RunCommandParameters?: eventbridge.RunCommandParameters;
  /** Parameters for ECS task targets. */
  EcsParameters?: RuleTargetEcsParameters;
  /** Parameters for AWS Batch job targets. */
  BatchParameters?: RuleTargetBatchParameters;
  /** Parameters for SQS queue targets (e.g., FIFO message group ID). */
  SqsParameters?: eventbridge.SqsParameters;
  /** Parameters for HTTP endpoint targets (API Gateway, API Destinations). */
  HttpParameters?: eventbridge.HttpParameters;
  /** Parameters for Amazon Redshift Data API targets. */
  RedshiftDataParameters?: eventbridge.RedshiftDataParameters;
  /** Parameters for SageMaker Pipeline targets. */
  SageMakerPipelineParameters?: eventbridge.SageMakerPipelineParameters;
  /** Dead-letter queue configuration for failed event delivery. */
  DeadLetterConfig?: RuleTargetDeadLetterConfig;
  /** Retry policy settings for the target. */
  RetryPolicy?: eventbridge.RetryPolicy;
  /** Parameters for AWS AppSync GraphQL API targets. */
  AppSyncParameters?: eventbridge.AppSyncParameters;
}

/** ECS parameters for a rule target with Input-wrapped ARN fields. */
export interface RuleTargetEcsParameters
  extends Omit<eventbridge.EcsParameters, "TaskDefinitionArn"> {
  /** ARN of the ECS task definition to run. */
  TaskDefinitionArn: Input<string>;
}

/** Batch parameters for a rule target with Input-wrapped ARN fields. */
export interface RuleTargetBatchParameters
  extends Omit<eventbridge.BatchParameters, "JobDefinition"> {
  /** ARN or name of the Batch job definition. */
  JobDefinition: Input<string>;
}

/** Dead-letter config for a rule target with Input-wrapped ARN. */
export interface RuleTargetDeadLetterConfig {
  /** ARN of the SQS queue used as the dead-letter queue. */
  Arn?: Input<string>;
}

export interface RuleProps {
  /**
   * Name of the rule. Must match [\.\-_A-Za-z0-9]+, 1-64 characters.
   * If omitted, a unique name will be generated.
   */
  name?: string;

  /**
   * Description of the rule. Max 512 characters.
   */
  description?: string;

  /**
   * The name or ARN of the event bus to associate with this rule.
   * If omitted, the default event bus is used.
   */
  eventBusName?: Input<string>;

  /**
   * The event pattern that triggers this rule. Specified as a JSON-compatible object.
   * A rule must contain at least an eventPattern or scheduleExpression.
   */
  eventPattern?: Record<string, any>;

  /**
   * The scheduling expression (e.g. "rate(5 minutes)", "cron(0 20 * * ? *)").
   * A rule must contain at least an eventPattern or scheduleExpression.
   */
  scheduleExpression?: string;

  /**
   * Whether the rule is enabled or disabled.
   * @default "ENABLED"
   */
  state?: eventbridge.RuleState;

  /**
   * ARN of the IAM role associated with the rule. Required for targets that need
   * IAM roles (e.g. Kinesis, Step Functions, ECS, API Gateway).
   */
  roleArn?: Input<string>;

  /**
   * The targets to invoke when this rule is triggered. Maximum 5 targets per rule.
   */
  targets?: RuleTarget[];

  /**
   * Tags to assign to the rule.
   */
  tags?: Record<string, Input<string>>;
}

export interface RuleAttrs<
  Props extends RuleProps = RuleProps,
> {
  /** The name of the rule. */
  ruleName: Props["name"] extends string ? Props["name"] : string;
  /** The ARN of the rule. */
  ruleArn: `arn:aws:events:${RegionID}:${AccountID}:rule/${string}`;
  /** The event bus associated with the rule. */
  eventBusName: string;
}

/**
 * An Amazon EventBridge rule that matches events and routes them to targets.
 *
 * @section Creating Rules
 * @example Event Pattern Rule
 * ```typescript
 * const rule = yield* Rule("S3Events", {
 *   eventPattern: {
 *     source: ["aws.s3"],
 *     "detail-type": ["Object Created"],
 *   },
 *   targets: [{
 *     Id: "MyTarget",
 *     Arn: yield* queue.queueArn(),
 *   }],
 * });
 * ```
 *
 * @example Scheduled Rule
 * ```typescript
 * const rule = yield* Rule("EveryFiveMinutes", {
 *   scheduleExpression: "rate(5 minutes)",
 *   targets: [{
 *     Id: "LambdaTarget",
 *     Arn: yield* fn.functionArn(),
 *   }],
 * });
 * ```
 *
 * @section Targeting
 * @example Rule with Input Transformer
 * ```typescript
 * const rule = yield* Rule("TransformedEvents", {
 *   eventPattern: {
 *     source: ["aws.ec2"],
 *     "detail-type": ["EC2 Instance State-change Notification"],
 *   },
 *   targets: [{
 *     Id: "SqsTarget",
 *     Arn: yield* queue.queueArn(),
 *     InputTransformer: {
 *       InputPathsMap: {
 *         instance: "$.detail.instance-id",
 *         state: "$.detail.state",
 *       },
 *       InputTemplate: '{"instanceId": <instance>, "newState": <state>}',
 *     },
 *   }],
 * });
 * ```
 *
 * @example Rule with Dead Letter Queue
 * ```typescript
 * const rule = yield* Rule("ReliableEvents", {
 *   eventPattern: { source: ["my.app"] },
 *   targets: [{
 *     Id: "Target",
 *     Arn: yield* fn.functionArn(),
 *     DeadLetterConfig: {
 *       Arn: yield* dlq.queueArn(),
 *     },
 *     RetryPolicy: {
 *       MaximumRetryAttempts: 3,
 *       MaximumEventAgeInSeconds: 3600,
 *     },
 *   }],
 * });
 * ```
 *
 * @example Rule with ECS Target
 * ```typescript
 * const rule = yield* Rule("EcsSchedule", {
 *   scheduleExpression: "rate(1 hour)",
 *   roleArn: yield* role.roleArn(),
 *   targets: [{
 *     Id: "EcsTask",
 *     Arn: yield* cluster.clusterArn(),
 *     RoleArn: yield* ecsRole.roleArn(),
 *     EcsParameters: {
 *       TaskDefinitionArn: yield* taskDef.taskDefinitionArn(),
 *       TaskCount: 1,
 *       LaunchType: "FARGATE",
 *       NetworkConfiguration: {
 *         awsvpcConfiguration: {
 *           Subnets: ["subnet-abc123"],
 *           AssignPublicIp: "ENABLED",
 *         },
 *       },
 *     },
 *   }],
 * });
 * ```
 */
export const Rule = Resource<{
  <const ID extends string, const Props extends RuleProps = RuleProps>(
    id: ID,
    props?: Props,
  ): Effect.Effect<Rule<ID, Props>>;
}>("AWS.EventBridge.Rule");

export interface Rule<
  ID extends string = string,
  Props extends RuleProps = RuleProps,
> extends Resource<
  "AWS.EventBridge.Rule",
  ID,
  Props,
  RuleAttrs<Input.Resolve<Props>>
> {}
