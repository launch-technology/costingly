/**
 * The one-time Link flow: connect a bank login and store its Item.
 *
 * Kept free of Express (or any HTTP framework) so the same two functions back
 * the local `plaid-sync link` server today and a Next.js route handler later.
 *
 * The flow, end to end:
 *   1. server: createLinkToken()            -> link_token
 *   2. browser: Plaid Link with that token  -> public_token   (credentials
 *      are entered inside Plaid's iframe and never reach this app)
 *   3. server: exchangePublicToken(...)     -> access_token, stored encrypted
 */

import { CountryCode, Products } from "plaid";
import type { LinkTokenCreateRequest } from "plaid";
import { getPlaidClient, describeError } from "./plaid.js";
import { saveItem, upsertAccounts } from "./items.js";
import { withTransaction } from "./db.js";

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

export interface CreateLinkTokenOptions {
  /**
   * Stable per-user id. Single-user local setup has exactly one, so it
   * defaults to a constant; pass a real user id if this ever goes multi-user.
   */
  clientUserId?: string;
  /**
   * Pass an existing Item's access_token to open Link in "update mode" and
   * repair an item whose status went to 'login_required'.
   */
  accessToken?: string;
}

export async function createLinkToken(options: CreateLinkTokenOptions = {}): Promise<string> {
  const { clientUserId = "local-user", accessToken } = options;

  const request: LinkTokenCreateRequest = {
    client_name: "plaid-sync",
    language: "en",
    country_codes: COUNTRY_CODES,
    user: { client_user_id: clientUserId },
  };

  if (accessToken !== undefined && accessToken !== "") {
    // Update mode. Plaid rejects `products` here — the Item's products are
    // already fixed and it only wants the token being repaired.
    request.access_token = accessToken;
  } else {
    request.products = PRODUCTS;
    // Must be set at Link time: /transactions/sync cannot widen the history
    // window afterwards.
    request.transactions = { days_requested: DAYS_REQUESTED };
  }

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
 * `plaid-sync sync` pull the full transaction history.
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
  await saveItem({ itemId, institutionId, institutionName, accessToken });

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
