export { createClient } from "./client.js";
export { ShardError, type ShardErrorCode } from "./errors.js";
export { normalize, type NormalizerName } from "./normalize.js";
export type { Manifest, ShardDescriptor, SchemaDescriptor, FieldSchemaEntry } from "./manifest.js";
export {
  assertWhereHasPruning,
  type ClientOptions,
  type Collection,
  type CollectionMeta,
  type CountOptions,
  type CountResult,
  type FieldKind,
  type FieldMeta,
  type FindManyArgs,
  type FindManyResult,
  type GenericClient,
  type OrderByOf,
  type SchemaMeta,
  type ValidateWhere,
  type WhereOf,
} from "./types.js";
