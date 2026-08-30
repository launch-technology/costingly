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
} from "./data/db/server.js";
export {
  describeDatabase,
  renderDatabaseDoc,
  type DatabaseDoc,
  type ViewDoc,
  type ColumnDoc,
} from "./data/db/dictionary.js";
export {
  query,
  withTransaction,
  describeDriver,
  type DbClient,
  type DbResult,
  type DbRow,
} from "./data/db/queries.js";
export { setMigrationSource, closeDb, ensureDatabaseExists } from "./data/db/bootstrap.js";
export { withConnection } from "./data/db/connections.js";
export {
  runMigrations,
  pendingMigrations,
  type Migration,
} from "./data/db/migrations.js";
export {
  queryReadOnly,
  type ReadOnlyOptions,
  type ReadOnlyResult,
} from "./data/db/queries.js";
export {
  isMissingSchema,
  explainDbError,
  MISSING_SCHEMA_CLI,
  MISSING_SCHEMA_MCP,
} from "./data/db/errors.js";
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
  upsertAccounts,
  deleteItem,
  type StoredItem,
  type SaveItemParams,
} from "./data/items.repository.js";
export {
  createLinkToken,
  exchangePublicToken,
  type LinkedItem,
} from "./services/banks/link.js";
export {
  syncAllItems,
  syncItem,
  type ItemSyncResult,
  type SyncSummary,
} from "./services/banks/sync.js";
export {
  countData,
  revokeAtPlaid,
  removeItem,
  removeAllItems,
  resetSyncedData,
  type DataCounts,
  type RemovalOutcome,
} from "./services/banks/remove.js";
