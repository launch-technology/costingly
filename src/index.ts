/**
 * What costingly exposes to a consumer that imports it as a library.
 *
 * Deliberately NOT used from inside src/ — a module that imports this imports
 * every layer at once, which is the opposite of what the layering is for. The
 * test suites use it as a façade, and one of them loads the BUILT dist/index.js
 * to prove the compiled package resolves.
 *
 * The layering rules enforce this: `tests/architecture.test.mts` fails if
 * anything under src/ reaches for it.
 */

export {
  get,
  getSecret,
  getSecretIfSet,
  describeConfig,
  writeConfig,
  readConfigFile,
  type PlaidEnvName,
  type StoredConfig,
  type ResolvedValue,
} from "./domain/config.js";
export { costingly, platform, configStore, ports, server } from "./domain/project.js";
export type { PlatformConfig, ProjectIdentity, ProfileSource } from "./platform/platform-config.js";
export type { ConfigStore } from "./platform/config-store.js";
export { encrypt, decrypt, generateEncryptionKey } from "./domain/crypto.js";
export type { Datastore, DatastoreState } from "./platform/datastore/datastore.js";
export {
  describeDatabase,
  type DatabaseDoc,
  type ViewDoc,
  type ColumnDoc,
} from "./domain/data/repositories/schema.repository.js";
export type { DataSource } from "./platform/postgres/types/data-source.js";
export type { Executor } from "./platform/postgres/types/executor.js";
export type { Transaction } from "./platform/postgres/types/transaction.js";
export type { DbResult } from "./platform/postgres/types/db-result.js";
export type { DbRow } from "./platform/postgres/types/db-row.js";
export { db, closeDb } from "./domain/data/default-database.js";
export { isMissingSchema } from "./platform/postgres/errors.js";
export {
  queryReadOnly,
  type ReadOnlyOptions,
  type ReadOnlyResult,
} from "./domain/services/query/readonly-query.service.js";
export { database, adminDataSource } from "./domain/data/default-database.js";
export {
  runMigrations,
  pendingMigrations,
  type Migration,
} from "./platform/postgres/migrations.js";
export {
  getPlaidClient,
  getPlaidError,
  describeError,
  isPlaidErrorCode,
  isMutationDuringPagination,
  isItemLoginRequired,
} from "./domain/data/plaid.client.js";
export {
  saveItem,
  getItem,
  listSyncableItems,
  listAllItems,
  setItemCursor,
  setItemStatus,
  deleteItem,
  type StoredItem,
  type SaveItemParams,
} from "./domain/data/repositories/items.repository.js";
export {
  createLinkToken,
  exchangePublicToken,
  type LinkedItem,
} from "./domain/services/banks/link.service.js";
export { createRepairLinkToken, markItemRepaired } from "./domain/services/banks/relink.service.js";
export {
  syncAllItems,
} from "./domain/services/banks/sync.service.js";
export type { ItemSyncResult, SyncSummary } from "./domain/services/banks/sync.types.js";
export {
  removeItem,
  countItemData,
  revokeIfPossible,
  type RemovalOutcome,
} from "./domain/services/banks/unlink.service.js";
export {
  countData,
  removeAllItems,
  resetSyncedData,
  type DataCounts,
} from "./domain/services/banks/reset.service.js";
