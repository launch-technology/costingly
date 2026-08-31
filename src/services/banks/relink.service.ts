/**
 * Repairing a bank connection whose credentials stopped working.
 *
 * Plaid calls this "update mode". Link opens straight into that bank's
 * re-authentication with no institution picker, and the Item is repaired in
 * place — same item id, same accounts, no second connection and no re-download
 * of two years of history.
 *
 * Kept apart from link.service.ts because the two are different operations that
 * happen to call the same Plaid endpoint: one creates an Item, this one only
 * ever touches an existing Item's status.
 */

import { getPlaidClient } from "../../data/plaid.client.js";
import { getItem, setItemStatus, type StoredItem } from "../../data/repositories/items.repository.js";
import { COUNTRY_CODES, CLIENT_USER_ID } from "./plaid.config.js";


/**
 * A token for repairing an existing Item, rather than connecting a new one.
 *
 * Plaid calls this "update mode". Link opens straight into that bank's
 * re-authentication with no institution picker, and the Item is repaired in
 * place — same item id, same accounts, no second connection and no re-download
 * of two years of history.
 *
 * `products` must be omitted: Plaid rejects it here, because the Item's products
 * were fixed when it was first created and this call is only about credentials.
 *
 * The caller passes an item id, never a token. Decrypting happens here so that a
 * Plaid access_token — a permanent bearer credential for someone's bank — never
 * leaves this process.
 */
export async function createRepairLinkToken(itemId: string): Promise<string> {
  const item = await requirePlaidItem(itemId);

  const response = await getPlaidClient().linkTokenCreate({
    client_name: "Costingly",
    language: "en",
    country_codes: COUNTRY_CODES,
    user: { client_user_id: CLIENT_USER_ID },
    access_token: item.accessToken,
  });
  return response.data.link_token;
}

/**
 * Record that an Item's credentials were repaired.
 *
 * Deliberately does NOT exchange a public token. Update mode hands one back on
 * success, and exchanging it would create a SECOND Item for the same bank —
 * duplicate billing, duplicate accounts, duplicate transactions — which is the
 * entire thing this flow exists to avoid. There is nothing to store: Plaid
 * repaired the credentials behind the existing access_token, which we already
 * hold.
 *
 * All that changes locally is the status. `sync` set it to 'login_required' when
 * the bank stopped answering; putting it back to 'active' is what returns the
 * Item to the syncable set. If the repair did not really take, the next sync
 * will set it straight back.
 */
export async function markItemRepaired(itemId: string): Promise<{ institutionName: string | null }> {
  const item = await requirePlaidItem(itemId);

  await setItemStatus(itemId, "active");
  return { institutionName: item.institutionName };
}

/**
 * Look up an Item that must be a real bank login.
 *
 * Both repair paths are meaningless for anything else: there is no bank to
 * re-authenticate with and no credential to replace. Saying so plainly beats
 * letting Plaid reject a null access_token with something unreadable.
 */
async function requirePlaidItem(itemId: string): Promise<StoredItem & { accessToken: string }> {
  const item = await getItem(itemId);
  if (item === null) throw new Error(`No linked bank has item_id "${itemId}".`);
  if (item.source !== "plaid" || item.accessToken === null) {
    throw new Error(
      `"${item.institutionName ?? itemId}" is sample data created by \`costingly seed\`, ` +
        `not a real bank connection. There is nothing to reconnect. ` +
        `Use unlink to remove it.`,
    );
  }
  return { ...item, accessToken: item.accessToken };
}
