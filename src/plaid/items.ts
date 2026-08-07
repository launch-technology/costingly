/**
 * Persistence for Plaid Items (bank logins) and their accounts.
 *
 * Access tokens are encrypted on the way in and decrypted on the way out, so
 * nothing above this layer ever handles the ciphertext and nothing below it
 * ever sees the plaintext.
 */

import type { AccountBase } from "plaid";
import type { DbClient } from "../db/client.js";
import { query } from "../db/client.js";
import { encrypt, decrypt } from "../crypto.js";

/** An Item as the rest of the app sees it: access token already decrypted. */
export interface StoredItem {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  /** Decrypted Plaid access_token. Never log this. */
  accessToken: string;
  /** `null` means never synced — Plaid will return the full history backfill. */
  cursor: string | null;
  status: string;
  lastSyncedAt: Date | null;
}

// Row shapes are `type` aliases, not `interface`s, on purpose: node-postgres'
// `QueryResultRow` constraint is an index-signature type, and only type-alias
// object types get an implicit index signature in TypeScript.
type ItemRow = {
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  access_token_enc: string;
  cursor: string | null;
  status: string;
  last_synced_at: Date | null;
};

function toStoredItem(row: ItemRow): StoredItem {
  return {
    itemId: row.item_id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    accessToken: decrypt(row.access_token_enc),
    cursor: row.cursor,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
  };
}

const ITEM_COLUMNS = `
  item_id, institution_id, institution_name, access_token_enc,
  cursor, status, last_synced_at
`;

export interface SaveItemParams {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  /** Plaintext access_token; encrypted before it touches the database. */
  accessToken: string;
}

/**
 * Insert or update an Item.
 *
 * Re-linking the same bank returns the same `item_id` and a new access_token,
 * so this upserts and refreshes the token — while deliberately leaving `cursor`
 * alone, so a re-link does not trigger a full re-backfill.
 */
export async function saveItem(params: SaveItemParams): Promise<void> {
  await query(
    `
    INSERT INTO items (item_id, institution_id, institution_name, access_token_enc, status, updated_at)
    VALUES ($1, $2, $3, $4, 'active', now())
    ON CONFLICT (item_id) DO UPDATE SET
      institution_id   = EXCLUDED.institution_id,
      institution_name = EXCLUDED.institution_name,
      access_token_enc = EXCLUDED.access_token_enc,
      status           = 'active',
      updated_at       = now()
    `,
    [
      params.itemId,
      params.institutionId,
      params.institutionName,
      encrypt(params.accessToken),
    ],
  );
}

/** Every Item the nightly sync should attempt, oldest-synced first. */
export async function listSyncableItems(): Promise<StoredItem[]> {
  const result = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE status = 'active' ORDER BY last_synced_at ASC NULLS FIRST, created_at ASC`,
  );
  return result.rows.map(toStoredItem);
}

/**
 * Every Item regardless of status, for maintenance commands.
 *
 * Unlike `listSyncableItems` this includes items in 'login_required' and any
 * other non-active state — you still need to be able to see and remove those.
 */
export async function listAllItems(): Promise<StoredItem[]> {
  const result = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items ORDER BY institution_name NULLS LAST, created_at ASC`,
  );
  return result.rows.map(toStoredItem);
}

export async function getItem(itemId: string): Promise<StoredItem | null> {
  const result = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE item_id = $1`,
    [itemId],
  );
  const row = result.rows[0];
  return row ? toStoredItem(row) : null;
}

/**
 * Advance the stored cursor and stamp the sync time.
 *
 * Takes an explicit client so it runs inside the same transaction as the
 * account/transaction writes it corresponds to.
 *
 * A `null` cursor means "Plaid did not give us a usable cursor this run" — it
 * is COALESCEd away rather than written, because clearing a good cursor would
 * silently trigger a full history re-backfill on the next run.
 */
export async function setItemCursor(
  client: DbClient,
  itemId: string,
  cursor: string | null,
): Promise<void> {
  await client.query(
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
export async function setItemStatus(itemId: string, status: string): Promise<void> {
  await query(`UPDATE items SET status = $2, updated_at = now() WHERE item_id = $1`, [
    itemId,
    status,
  ]);
}

/**
 * Upsert the accounts belonging to an Item, refreshing balances.
 *
 * Must run before transactions are written: `transactions.account_id` is a
 * foreign key into this table, and a brand-new account (or a first-ever sync)
 * would otherwise fail the constraint.
 */
export async function upsertAccounts(
  client: DbClient,
  itemId: string,
  accounts: readonly AccountBase[],
): Promise<number> {
  if (accounts.length === 0) return 0;

  for (const account of accounts) {
    const { balances } = account;
    await client.query(
      `
      INSERT INTO accounts (
        account_id, item_id, name, official_name, mask, type, subtype,
        currency, current_balance, available_balance, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (account_id) DO UPDATE SET
        item_id           = EXCLUDED.item_id,
        name              = EXCLUDED.name,
        official_name     = EXCLUDED.official_name,
        mask              = EXCLUDED.mask,
        type              = EXCLUDED.type,
        subtype           = EXCLUDED.subtype,
        currency          = EXCLUDED.currency,
        current_balance   = EXCLUDED.current_balance,
        available_balance = EXCLUDED.available_balance,
        updated_at        = now()
      `,
      [
        account.account_id,
        itemId,
        account.name,
        account.official_name,
        account.mask,
        account.type,
        account.subtype,
        balances.iso_currency_code ?? balances.unofficial_currency_code,
        balances.current,
        balances.available,
      ],
    );
  }

  return accounts.length;
}

/**
 * Delete an Item and everything under it (accounts and transactions cascade).
 *
 * Note: this only removes local data. To also stop Plaid billing for the Item
 * and revoke the token, call `/item/remove` as well.
 */
export async function deleteItem(itemId: string): Promise<void> {
  await query(`DELETE FROM items WHERE item_id = $1`, [itemId]);
}
