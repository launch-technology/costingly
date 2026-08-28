/**
 * The one-time Link flow: connect a bank login and store its Item.
 *
 * Kept free of Express (or any HTTP framework) so the same two functions back
 * the local `costingly link` server today and a Next.js route handler later.
 *
 * The flow, end to end:
 *   1. server: createLinkToken()            -> link_token
 *   2. browser: Plaid Link with that token  -> public_token   (credentials
 *      are entered inside Plaid's iframe and never reach this app)
 *   3. server: exchangePublicToken(...)     -> access_token, stored encrypted
 */

import { CountryCode, Products } from "plaid";
import type { LinkTokenCreateRequest } from "plaid";
import { getPlaidClient, describeError } from "./client.js";
import { getItem, saveItem, setItemStatus, upsertAccounts, type StoredItem } from "./items.js";
import { withTransaction } from "../db/queries.js";

/**
 * Only `transactions` is requested. That is what keeps this integration
 * read-only: no auth (account/routing numbers), no identity, no transfer.
 */
const PRODUCTS: Products[] = [Products.Transactions];
const COUNTRY_CODES: CountryCode[] = [CountryCode.Us];

/**
 * How much history to pull on the initial backfill.
 *
 * 730 days is the maximum Plaid will attempt; banks vary in how much they
 * actually hold. Because transactions are initialised at Link time, this has to
 * be set here — `/transactions/sync` cannot widen the window afterwards, and
 * the only way to change it later is to remove the Item and re-link.
 */
const DAYS_REQUESTED = 730;

/**
 * Plaid wants a stable per-user id. This install serves exactly one person, so
 * it is a constant.
 */
const CLIENT_USER_ID = "local-user";

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

/** A token for one fresh Plaid Link session, connecting a new bank. */
export async function createLinkToken(): Promise<string> {
  const request: LinkTokenCreateRequest = {
    client_name: "Costingly",
    language: "en",
    country_codes: COUNTRY_CODES,
    user: { client_user_id: CLIENT_USER_ID },
    products: PRODUCTS,
    // Must be set at Link time: /transactions/sync cannot widen the history
    // window afterwards.
    transactions: { days_requested: DAYS_REQUESTED },
  };

  const response = await getPlaidClient().linkTokenCreate(request);
  return response.data.link_token;
}

export interface LinkedItem {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  accountCount: number;
}

/**
 * Exchange a `public_token` for a permanent `access_token`, resolve the
 * institution, and store the Item together with its accounts.
 *
 * `cursor` is deliberately left NULL, which is what makes the first
 * `costingly sync` pull the full transaction history.
 */
export async function exchangePublicToken(publicToken: string): Promise<LinkedItem> {
  const plaid = getPlaidClient();

  const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const itemId = exchange.data.item_id;

  const { institutionId, institutionName } = await resolveInstitution(accessToken);

  // Store the Item before fetching accounts: if the accounts call fails we
  // still hold the access_token, so nothing is orphaned and a re-run repairs
  // the rest. (Losing an access_token would mean re-linking the bank.)
  await saveItem({ itemId, institutionId, institutionName, accessToken, source: "plaid" });

  const accounts = await plaid.accountsGet({ access_token: accessToken });
  await withTransaction(async (client) => {
    await upsertAccounts(client, itemId, accounts.data.accounts);
  });

  return {
    itemId,
    institutionId,
    institutionName,
    accountCount: accounts.data.accounts.length,
  };
}

/**
 * Look up the institution behind an Item.
 *
 * `/item/get` often carries the name already; when it does not, fall back to
 * `/institutions/get_by_id`. Neither is essential — the name is cosmetic — so
 * a failure here is logged and the Item is stored without it.
 */
async function resolveInstitution(accessToken: string): Promise<{
  institutionId: string | null;
  institutionName: string | null;
}> {
  const plaid = getPlaidClient();

  try {
    const item = await plaid.itemGet({ access_token: accessToken });
    const institutionId = item.data.item.institution_id ?? null;
    const institutionName = item.data.item.institution_name ?? null;

    if (institutionName !== null || institutionId === null) {
      return { institutionId, institutionName };
    }

    const institution = await plaid.institutionsGetById({
      institution_id: institutionId,
      country_codes: COUNTRY_CODES,
    });
    return { institutionId, institutionName: institution.data.institution.name };
  } catch (error) {
    console.warn(`[link] could not resolve institution name: ${describeError(error)}`);
    return { institutionId: null, institutionName: null };
  }
}
