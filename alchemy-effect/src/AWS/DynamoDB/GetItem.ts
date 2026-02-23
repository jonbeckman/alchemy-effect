import type { ConsumedCapacity } from "distilled-aws/dynamodb";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Policy from "../../Policy/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as Lambda from "../Lambda/index.ts";
import { fromAttributeValue } from "./AttributeValue.ts";
import type { Table } from "./Table.ts";

export interface GetItemConstraint<
  LeadingKeys extends Policy.AnyOf<any> = Policy.AnyOf<any>,
  Attributes extends Policy.AnyOf<any> = Policy.AnyOf<any>,
  ReturnConsumedCapacityValue extends Policy.AnyOf<any> = Policy.AnyOf<any>,
> {
  leadingKeys?: LeadingKeys;
  attributes?: Attributes;
  returnConsumedCapacity?: ReturnConsumedCapacityValue;
}

type AnyOfValue<T> = T extends Policy.AnyOf<infer V> ? V : never;
type ConstrainLeadingKey<
  T extends Table,
  LeadingKeys extends Policy.AnyOf<any> | never,
> = [LeadingKeys] extends [never]
  ? Table.Key<T>
  : Omit<Table.Key<T>, Table.PartitionKey<T>> & {
      [K in Table.PartitionKey<T>]: Extract<
        Table.Key<T>[K],
        AnyOfValue<LeadingKeys>
      >;
    };

export interface GetItemRequest<
  T extends Table,
  LeadingKeys extends Policy.AnyOf<any> | never = never,
> extends Omit<DynamoDB.GetItemInput, "TableName" | "Key"> {
  Key: ConstrainLeadingKey<T, LeadingKeys>;
}

export interface GetItemResult<T extends Table, Key extends Table.Key<T>> {
  Item: (InstanceType<T["props"]["items"]> & Key) | undefined;
  ConsumedCapacity?: ConsumedCapacity;
}

export const GetItem = Effect.fn(function* <
  T extends Table,
  const LeadingKeys extends Policy.AnyOf<any> = never,
  const Attributes extends Policy.AnyOf<any> = never,
  const ReturnConsumedCapacityValue extends Policy.AnyOf<any> = never,
>(
  table: T,
  constraint?: GetItemConstraint<
    LeadingKeys,
    Attributes,
    ReturnConsumedCapacityValue
  >,
) {
  yield* bindGetItem(table, constraint);
  const TableName = yield* table.tableName();
  Effect.fn("AWS.DynamoDB.GetItem")(function* (request: GetItemRequest<T, LeadingKeys>) {
    const tableName = yield* TableName;
    const { Item, ...rest } = yield* DynamoDB.getItem({
      ...request,
      TableName: tableName,
      Key: {
        [table.props.partitionKey]: {
          S: (request.Key as any)[table.props.partitionKey] as string,
        },
        ...(table.props.sortKey
          ? {
              [table.props.sortKey]: {
                S: (request.Key as any)[table.props.sortKey] as string,
              },
            }
          : {}),
      },
    });

    return {
      ...rest,
      Item: Item
        ? (Object.fromEntries(
            yield* Effect.promise(() =>
              Promise.all(
                Object.entries(Item!).map(async ([key, value]) => [
                  key,
                  await fromAttributeValue(value!),
                ]),
              ),
            ),
          ) as any)
        : undefined,
    };
  });
});

export const bindGetItem = Binding.fn<GetItemBinding>(
  "AWS.DynamoDB.GetItem",
);

export class GetItemBinding extends Binding.Service(
  "AWS.DynamoDB.GetItem",
  Effect.fn(function* <T extends Table>(
    table: T,
    constraint?: GetItemConstraint,
  ) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "GetItem",
            Effect: "Allow",
            Action: ["dynamodb:GetItem"],
            Resource: [Output.interpolate`${table.tableArn()}`],
            Condition:
              constraint?.leadingKeys ||
              constraint?.attributes ||
              constraint?.returnConsumedCapacity
                ? {
                    "ForAllValues:StringEquals": {
                      "dynamodb:LeadingKeys": constraint.leadingKeys
                        ?.anyOf as string[],
                      "dynamodb:Attributes": constraint.attributes
                        ?.anyOf as string[],
                      "dynamodb:ReturnConsumedCapacity": constraint
                        .returnConsumedCapacity?.anyOf as string[],
                    },
                  }
                : undefined,
          },
        ],
      });
    }
    return yield* Effect.die(
      `GetItemBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
