/**
 * Public surface of the framework-agnostic core.
 *
 * Everything below `src/` depends only on `plaid`, `pg` and Node built-ins —
 * no Express, no commander, no clack. That boundary is what keeps the sync
 * logic liftable into another host later.
 */

export {
  get,
  getSecret,
  getSecretIfSet,
  describeConfig,
  writeConfig,
  updateConfigSync,
  readConfigFile,
  type PlaidEnvName,
  type StoredConfig,
  type ResolvedValue,
} from "./core/config.js";
export {
  profileDir,
  profileSource,
  configPath,
  displayPath,
  APP_NAME,
  type ProfileSource,
} from "./core/profile.js";
export { encrypt, decrypt, generateEncryptionKey } from "./core/crypto.js";
export {
  ensureServerRunning,
  stopServer,
  serverStatus,
  describeServer,
  clusterDir,
  serverLogPath,
  DATABASE_NAME,
  type ServerState,
} from "./postgres/server.js";
export {
  describeDatabase,
  type DatabaseDoc,
  type ViewDoc,
  type ColumnDoc,
} from "./data/repositories/schema.repository.js";
export type { DataSource } from "./data/db/types/data-source.js";
export type { Executor } from "./data/db/types/executor.js";
export type { Transaction } from "./data/db/types/transaction.js";
export type { DbResult } from "./data/db/types/db-result.js";
export type { DbRow } from "./data/db/types/db-row.js";
export { db, closeDb } from "./data/db/data-source-registry.js";
export { isMissingSchema } from "./data/db/errors.js";
export {
  queryReadOnly,
  type ReadOnlyOptions,
  type ReadOnlyResult,
} from "./data/db/readonly-query.js";
export { ensureDatabaseExists } from "./data/db/bootstrap.js";
export { adminDataSource } from "./data/db/data-source-registry.js";
export {
  setMigrationSource,
  runMigrations,
  pendingMigrations,
  type Migration,
} from "./data/db/migrations.js";
export {
  getPlaidClient,
  getPlaidError,
  describeError,
  isPlaidErrorCode,
  isMutationDuringPagination,
  isItemLoginRequired,
} from "./data/plaid.client.js";
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
} from "./data/repositories/items.repository.js";
export {
  createLinkToken,
  exchangePublicToken,
  type LinkedItem,
} from "./services/banks/link.service.js";
export { createRepairLinkToken, markItemRepaired } from "./services/banks/relink.service.js";
export {
  syncAllItems,
} from "./services/banks/sync.service.js";
export type { ItemSyncResult, SyncSummary } from "./services/banks/sync.types.js";
export {
  removeItem,
  countItemData,
  revokeIfPossible,
  type RemovalOutcome,
} from "./services/banks/unlink.service.js";
export {
  countData,
  removeAllItems,
  resetSyncedData,
  type DataCounts,
} from "./services/banks/reset.service.js";
