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
} from "./config.js";
export {
  profileDir,
  profileSource,
  configPath,
  displayPath,
  APP_NAME,
  type ProfileSource,
} from "./profile.js";
export { encrypt, decrypt, generateEncryptionKey } from "./crypto.js";
export {
  ensureServerRunning,
  stopServer,
  serverStatus,
  ensureDatabaseExists,
  describeServer,
  clusterDir,
  socketDir,
  serverLogPath,
  connectionString,
  DATABASE_NAME,
  type ServerState,
} from "./db/server.js";
export {
  describeDatabase,
  renderDatabaseDoc,
  type DatabaseDoc,
  type ViewDoc,
  type ColumnDoc,
} from "./db/dictionary.js";
export {
  query,
  withTransaction,
  setMigrationSource,
  closeDb,
  describeDriver,
  type DbClient,
  type DbResult,
  type DbRow,
} from "./db/client.js";
export {
  runMigrations,
  pendingMigrations,
  type Migration,
} from "./db/migrate.js";
export {
  queryReadOnly,
  type ReadOnlyOptions,
  type ReadOnlyResult,
} from "./db/readonly.js";
export {
  isMissingSchema,
  explainDbError,
  MISSING_SCHEMA_CLI,
  MISSING_SCHEMA_MCP,
} from "./db/errors.js";
export {
  getPlaidClient,
  getPlaidError,
  describeError,
  isPlaidErrorCode,
  isMutationDuringPagination,
  isItemLoginRequired,
} from "./plaid/client.js";
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
} from "./plaid/items.js";
export {
  createLinkToken,
  exchangePublicToken,
  type LinkedItem,
} from "./plaid/link.js";
export {
  syncAllItems,
  syncItem,
  type ItemSyncResult,
  type SyncSummary,
} from "./plaid/sync.js";
export {
  countData,
  revokeAtPlaid,
  removeItem,
  removeAllItems,
  resetSyncedData,
  type DataCounts,
  type RemovalOutcome,
} from "./plaid/remove.js";
