/**
 * Public surface of the framework-agnostic core.
 *
 * Everything below `src/` depends only on `plaid`, `pg` and Node built-ins —
 * no Express, no dotenv, no Next.js. Copy this directory into a Next.js repo
 * and the imports keep working unchanged.
 */

export { config, type PlaidEnvName } from "./config.js";
export { encrypt, decrypt, generateEncryptionKey, safeEqual } from "./crypto.js";
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
} from "./server.js";
export {
  query,
  execScript,
  withTransaction,
  closeDb,
  describeDriver,
  usingRemoteDatabase,
  type DbClient,
  type DbResult,
  type DbRow,
} from "./db.js";
export {
  getPlaidClient,
  getPlaidError,
  describeError,
  isPlaidErrorCode,
  isMutationDuringPagination,
  isItemLoginRequired,
} from "./plaid.js";
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
} from "./items.js";
export {
  createLinkToken,
  exchangePublicToken,
  type CreateLinkTokenOptions,
  type LinkedItem,
} from "./link.js";
export {
  syncAllItems,
  syncItem,
  type ItemSyncResult,
  type SyncSummary,
} from "./sync.js";
export {
  countData,
  revokeAtPlaid,
  removeItem,
  removeAllItems,
  resetSyncedData,
  type DataCounts,
  type RemovalOutcome,
} from "./remove.js";
