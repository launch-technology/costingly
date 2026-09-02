/**
 * Persistence for Plaid Items (bank logins) and their accounts.
 *
 * Access tokens are encrypted on the way in and decrypted on the way out, so
 * nothing above this layer ever handles the ciphertext and nothing below it
 * ever sees the plaintext.
 */

import type { Executor } from "../../../platform/postgres/types/executor.js";
import { encrypt, decrypt } from "../../crypto.js";

/**
 * Where an Item's data came from. See migrations/0002-item-source.sql.
 *
 *   plaid  a real bank login, with an access_token behind it
 *   seed   fabricated sample data from `costingly seed` — no bank, no token
 */
export type ItemSource = "plaid" | "seed";

/** An Item as the rest of the app sees it: access token already decrypted. */
export interface StoredItem {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  /**
   * Decrypted Plaid access_token. Never log this.
   *
   * `null` when there is no bank connection at all — `source: "seed"`. The
   * database enforces that a 'plaid' Item always has one, so a null here is
   * always the seeded case and never a corrupt row.
   */
  accessToken: string | null;
  /** `null` means never synced — Plaid will return the full history backfill. */
  cursor: string | null;
  status: string;
  source: ItemSource;
  lastSyncedAt: Date | null;
}

/**
 * An Item that can actually be talked to: source 'plaid', so `accessToken` is
 * present. Narrowing it here means sync and revoke never carry a null check for
 * a case their query already excluded.
 */
export interface SyncableItem extends Omit<StoredItem, "accessToken"> {
  accessToken: string;
}

// Row shapes are `type` aliases, not `interface`s, on purpose: node-postgres'
// `QueryResultRow` constraint is an index-signature type, and only type-alias
// object types get an implicit index signature in TypeScript.
type ItemRow = {
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  access_token_enc: string | null;
  cursor: string | null;
  status: string;
  source: string;
  last_synced_at: Date | null;
};

function toStoredItem(row: ItemRow): StoredItem {
  return {
    itemId: row.item_id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    accessToken: row.access_token_enc === null ? null : decrypt(row.access_token_enc),
    cursor: row.cursor,
    status: row.status,
    source: row.source === "seed" ? "seed" : "plaid",
    lastSyncedAt: row.last_synced_at,
  };
}

const ITEM_COLUMNS = `
  item_id, institution_id, institution_name, access_token_enc,
  cursor, status, source, last_synced_at
`;

export interface SaveItemParams {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  source: ItemSource;
  /**
   * Plaintext access_token; encrypted before it touches the database. `null`
   * only for sources that have no credential — the database rejects a 'plaid'
   * row without one.
   */
  accessToken: string | null;
}

/**
 * Insert or update an Item.
 *
 * Re-linking the same bank returns the same `item_id` and a new access_token,
 * so this upserts and refreshes the token — while deliberately leaving `cursor`
 * alone, so a re-link does not trigger a full re-backfill.
 */
export async function saveItem(exec: Executor, params: SaveItemParams): Promise<void> {
  await exec.query(
    `
    INSERT INTO items (item_id, institution_id, institution_name, access_token_enc, source, status, updated_at)
    VALUES ($1, $2, $3, $4, $5, 'active', now())
    ON CONFLICT (item_id) DO UPDATE SET
      institution_id   = EXCLUDED.institution_id,
      institution_name = EXCLUDED.institution_name,
      access_token_enc = EXCLUDED.access_token_enc,
      source           = EXCLUDED.source,
      status           = 'active',
      updated_at       = now()
    `,
    [
      params.itemId,
      params.institutionId,
      params.institutionName,
      params.accessToken === null ? null : encrypt(params.accessToken),
      params.source,
    ],
  );
}

/**
 * Every Item the nightly sync should attempt, oldest-synced first.
 *
 * `source = 'plaid'` is the filter that keeps seeded data out of sync — not the
 * token being null. Those coincide today, but a second provider would have a
 * token and still not belong in a Plaid sync, and this query would then be
 * wrong in a way that is expensive to notice.
 */
export async function listSyncableItems(exec: Executor): Promise<SyncableItem[]> {
  const result = await exec.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items
      WHERE status = 'active' AND source = 'plaid'
      ORDER BY last_synced_at ASC NULLS FIRST, created_at ASC`,
  );
  return result.rows.map(toStoredItem).filter(isSyncable);
}

/**
 * Narrow a StoredItem to one that can be synced.
 *
 * The `source = 'plaid'` filter plus the items_plaid_needs_token constraint
 * already guarantee this, so the predicate should never reject anything. It
 * exists so the guarantee is expressed in the type system rather than in a
 * comment and a cast.
 */
function isSyncable(item: StoredItem): item is SyncableItem {
  return item.source === "plaid" && item.accessToken !== null;
}

/**
 * Every Item regardless of status, for maintenance commands.
 *
 * Unlike `listSyncableItems` this includes items in 'login_required' and any
 * other non-active state — you still need to be able to see and remove those.
 */
export async function listAllItems(exec: Executor): Promise<StoredItem[]> {
  const result = await exec.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items ORDER BY institution_name NULLS LAST, created_at ASC`,
  );
  return result.rows.map(toStoredItem);
}

export async function getItem(exec: Executor, itemId: string): Promise<StoredItem | null> {
  const result = await exec.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE item_id = $1`,
    [itemId],
  );
  const row = result.rows[0];
  return row ? toStoredItem(row) : null;
}

/**
 * Advance the stored cursor and stamp the sync time.
 *
 * The caller must run this in the same transaction as the rows it describes.
 * The new cursor is a claim that everything Plaid reported up to that position
 * is already written; committing it without them means Plaid never resends
 * those changes and the data is gone. Transaction scope is the service layer's
 * to decide — see syncItem() — so this takes a plain Executor and trusts it.
 *
 * A `null` cursor means "Plaid did not give us a usable cursor this run" — it
 * is COALESCEd away rather than written, because clearing a good cursor would
 * silently trigger a full history re-backfill on the next run.
 */
export async function setItemCursor(
  exec: Executor,
  itemId: string,
  cursor: string | null,
): Promise<void> {
  await exec.query(
    `UPDATE items
       SET cursor = COALESCE($2, cursor),
           last_synced_at = now(),
           updated_at = now()
     WHERE item_id = $1`,
    [itemId, cursor],
  );
}

/**
 * Mark an Item's health, e.g. 'login_required' after ITEM_LOGIN_REQUIRED.
 *
 * Runs outside any transaction: it is called on the failure path, where the
 * item's transaction has already been rolled back.
 */
export async function setItemStatus(exec: Executor, itemId: string, status: string): Promise<void> {
  await exec.query(`UPDATE items SET status = $2, updated_at = now() WHERE item_id = $1`, [
    itemId,
    status,
  ]);
}


/**
 * Delete an Item and everything under it (accounts and transactions cascade).
 *
 * Note: this only removes local data. To also stop Plaid billing for the Item
 * and revoke the token, call `/item/remove` as well.
 */
export async function deleteItem(exec: Executor, itemId: string): Promise<void> {
  await exec.query(`DELETE FROM items WHERE item_id = $1`, [itemId]);
}

/** An Item named without decrypting anything. */
export interface ItemSummary {
  itemId: string;
  institutionName: string | null;
  status: string;
}

/** How many Items exist, whatever their source. */
export async function countAll(exec: Executor): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM items`);
  return Number(rows[0]?.count ?? 0);
}

/** How many Items came from a given source. */
export async function countBySource(exec: Executor, source: ItemSource): Promise<number> {
  const { rows } = await exec.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM items WHERE source = $1`,
    [source],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Every Item, as id and name only.
 *
 * Deliberately not listAllItems(): that decrypts every access token, so one
 * Item whose token no longer decrypts would throw and make it impossible to
 * list — or remove — ANY of them. That is precisely the situation in which
 * someone most wants to clean up.
 */
export async function listBasic(exec: Executor): Promise<ItemSummary[]> {
  const { rows } = await exec.query<{ item_id: string; institution_name: string | null; status: string }>(
    `SELECT item_id, institution_name, status FROM items
      ORDER BY institution_name NULLS LAST, created_at`,
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    institutionName: row.institution_name,
    status: row.status,
  }));
}

/** Delete every Item. Accounts and transactions cascade. */
export async function deleteAll(exec: Executor): Promise<void> {
  await exec.query(`DELETE FROM items`);
}

/** Delete every Item from one source. Accounts and transactions cascade. */
export async function deleteBySource(exec: Executor, source: ItemSource): Promise<void> {
  await exec.query(`DELETE FROM items WHERE source = $1`, [source]);
}

/**
 * Forget where each sync got to, so the next one backfills from scratch.
 *
 * The caller must run this in the same transaction as the deletion of the rows
 * these cursors describe — separating them would make the missing history
 * unrecoverable without a re-link. See resetSyncedData().
 */
export async function clearCursors(exec: Executor): Promise<void> {
  await exec.query(`UPDATE items SET cursor = NULL, last_synced_at = NULL, updated_at = now()`);
}

/** One row of the status report: an Item, one of its accounts, and its counts. */
export interface ItemAccountListing {
  item_id: string;
  institution_name: string | null;
  status: string;
  last_synced_at: Date | null;
  never_synced: boolean;
  source: ItemSource;
  account_id: string | null;
  account_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  current_balance: string | null;
  txn_count: string;
  first_date: string | null;
  last_date: string | null;
}

/**
 * Every Item with every account beneath it, and each account's transaction
 * count and date range.
 *
 * A LEFT JOIN throughout: an Item that has just been linked but never synced
 * has no accounts yet, and it still has to appear — that state is exactly what
 * someone running `status` is trying to see.
 */
export async function listWithAccounts(exec: Executor): Promise<ItemAccountListing[]> {
  const { rows } = await exec.query<ItemAccountListing>(`
    SELECT i.item_id,
           i.institution_name,
           i.status,
           i.last_synced_at,
           i.cursor IS NULL           AS never_synced,
           i.source,
           a.account_id,
           a.name                     AS account_name,
           a.mask,
           a.type,
           a.subtype,
           a.currency,
           a.current_balance,
           COALESCE(t.txn_count, 0)::text AS txn_count,
           t.first_date::text         AS first_date,
           t.last_date::text          AS last_date
      FROM items i
      LEFT JOIN accounts a ON a.item_id = i.item_id
      LEFT JOIN LATERAL (
             SELECT COUNT(*) AS txn_count, MIN(date) AS first_date, MAX(date) AS last_date
               FROM transactions
              WHERE account_id = a.account_id
           ) t ON TRUE
     ORDER BY i.institution_name NULLS LAST, a.name NULLS LAST
  `);
  return rows;
}
