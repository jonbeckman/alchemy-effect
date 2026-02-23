import type * as Effect from "effect/Effect";

import type * as eventbridge from "distilled-aws/eventbridge";
import type { Input } from "../../Input.ts";
import { Resource } from "../../Resource.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type { LogConfig, IncludeDetail, Level } from "distilled-aws/eventbridge";

export interface EventBusDeadLetterConfig {
  /** ARN of the SQS queue used as the dead-letter queue. */
  Arn?: Input<string>;
}

export interface EventBusProps {
  /**
   * Name of the event bus. Must match [/\.\-_A-Za-z0-9]+, 1-256 characters.
   * If omitted, a unique name will be generated.
   * Cannot be "default" — use the default event bus by omitting eventBusName on rules.
   */
  name?: string;

  /**
   * The partner event source to associate with this event bus.
   * Only used when creating a partner event bus.
   */
  eventSourceName?: string;

  /**
   * Description of the event bus.
   */
  description?: string;

  /**
   * The identifier of the KMS customer managed key for EventBridge to use
   * to encrypt events on this event bus.
   */
  kmsKeyIdentifier?: Input<string>;

  /**
   * Dead-letter queue configuration for undeliverable events.
   */
  deadLetterConfig?: EventBusDeadLetterConfig;

  /**
   * Logging configuration for the event bus.
   */
  logConfig?: eventbridge.LogConfig;

  /**
   * Tags to assign to the event bus.
   */
  tags?: Record<string, Input<string>>;
}

export interface EventBusAttrs<
  Props extends EventBusProps = EventBusProps,
> {
  /** The name of the event bus. */
  eventBusName: Props["name"] extends string ? Props["name"] : string;
  /** The ARN of the event bus. */
  eventBusArn: `arn:aws:events:${RegionID}:${AccountID}:event-bus/${string}`;
  /** Description of the event bus, if set. */
  description?: string;
}

/**
 * An Amazon EventBridge event bus for receiving and routing events.
 *
 * @section Creating Event Buses
 * @example Custom Event Bus
 * ```typescript
 * const bus = yield* EventBus("MyAppEvents", {
 *   description: "Custom event bus for my application",
 * });
 * ```
 *
 * @example Event Bus with Dead Letter Queue
 * ```typescript
 * const bus = yield* EventBus("ReliableBus", {
 *   deadLetterConfig: {
 *     Arn: yield* dlq.queueArn(),
 *   },
 * });
 * ```
 *
 * @example Event Bus with KMS Encryption
 * ```typescript
 * const bus = yield* EventBus("EncryptedBus", {
 *   kmsKeyIdentifier: yield* key.keyArn(),
 * });
 * ```
 */
export const EventBus = Resource<{
  <const ID extends string, const Props extends EventBusProps = EventBusProps>(
    id: ID,
    props?: Props,
  ): Effect.Effect<EventBus<ID, Props>>;
}>("AWS.EventBridge.EventBus");

export interface EventBus<
  ID extends string = string,
  Props extends EventBusProps = EventBusProps,
> extends Resource<
  "AWS.EventBridge.EventBus",
  ID,
  Props,
  EventBusAttrs<Input.Resolve<Props>>
> {}
