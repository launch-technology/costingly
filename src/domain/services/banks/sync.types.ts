/**
 * What a sync reports back.
 *
 * Separate from the service because these travel: the MCP sync tool renders a
 * SyncSummary, and a caller that only needs to describe a result should not
 * have to import the machinery that produces one.
 */

import type { TransactionsUpdateStatus } from "plaid";

/** Rows per multi-row INSERT. 200 x 14 params is well under Postgres' 65535. */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ItemSyncResult {
  itemId: string;
  institutionName: string | null;
  ok: boolean;
  /** Counts as reported by Plaid across all pages. */
  added: number;
  modified: number;
  removed: number;
  accounts: number;
  /** Number of /transactions/sync pages fetched. */
  pages: number;
  /** True when the Item had no cursor, i.e. this was the full-history backfill. */
  initialBackfill: boolean;
  /**
   * Plaid's view of how far the Item's data has caught up. On a brand-new Item
   * this is often NOT_READY with zero transactions: Plaid is still pulling
   * history in the background and the next run will return it.
   */
  updateStatus: TransactionsUpdateStatus | null;
  /** Present only when `ok` is false. */
  error?: string;
}

export interface SyncSummary {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  itemsTotal: number;
  itemsSucceeded: number;
  itemsFailed: number;
  added: number;
  modified: number;
  removed: number;
  results: ItemSyncResult[];
}
