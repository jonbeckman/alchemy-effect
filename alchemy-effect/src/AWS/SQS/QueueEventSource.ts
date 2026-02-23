import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface QueueEventSourceProps {
  /**
   * The maximum number of records in each batch that Lambda pulls from the queue.
   * @default 10
   */
  batchSize?: number;
  /**
   * The maximum amount of time, in seconds, that Lambda spends gathering records before invoking the function.
   * @default 0
   */
  maximumBatchingWindowInSeconds?: number;
  /**
   * Whether the event source mapping is active.
   * @default true
   */
  enabled?: boolean;
  /**
   * A list of current response type enums applied to the event source mapping.
   * @default ["ReportBatchItemFailures"]
   */
  functionResponseTypes?: Lambda.FunctionResponseType[];
  /**
   * Scaling configuration for the event source.
   */
  scalingConfig?: Lambda.EventSourceMappingProps["scalingConfig"];
  /**
   * Filter criteria to control which records are sent to the function.
   */
  filterCriteria?: Lambda.EventSourceMappingProps["filterCriteria"];
}

export const QueueEventSource = Binding.fn<QueueEventSourceBinding>(
  "AWS.SQS.QueueEventSource",
);

export class QueueEventSourceBinding extends Binding.Service(
  "AWS.SQS.QueueEventSource",
  Effect.fn(function* (
    queue: Queue,
    props: QueueEventSourceProps = {},
  ) {
    const runtime = yield* Runtime;

    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "QueueEventSource",
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ],
            Resource: [Output.interpolate`${queue.queueArn()}`],
          },
        ],
      });

      yield* Lambda.EventSourceMapping(`${queue.id}-EventSource`, {
        functionName: yield* runtime.functionName(),
        eventSourceArn: yield* queue.queueArn(),
        batchSize: props.batchSize,
        maximumBatchingWindowInSeconds: props.maximumBatchingWindowInSeconds,
        enabled: props.enabled,
        functionResponseTypes: props.functionResponseTypes,
        scalingConfig: props.scalingConfig,
        filterCriteria: props.filterCriteria,
      });
    } else {
      return yield* Effect.die(
        `QueueEventSource is not supported in runtime '${runtime.type}'`,
      );
    }
  }),
) {}
