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
 *
 * Repairing an existing connection is a different operation — see
 * relink.service.ts.
 */

import type { LinkTokenCreateRequest } from "plaid";
import { getPlaidClient, describeError } from "../../data/plaid.client.js";
import { saveItem } from "../../data/repositories/items.repository.js";
import { upsertMany as upsertAccountRows } from "../../data/repositories/accounts.repository.js";
import { toAccountRow } from "./plaid.mappers.js";
import { db } from "../../data/db/data-source-registry.js";
import { PRODUCTS, COUNTRY_CODES, DAYS_REQUESTED, CLIENT_USER_ID } from "./plaid.config.js";


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
  await saveItem(db, { itemId, institutionId, institutionName, accessToken, source: "plaid" });

  const accounts = await plaid.accountsGet({ access_token: accessToken });
  await db.transaction(async (tx) => {
    await upsertAccountRows(tx, accounts.data.accounts.map((a) => toAccountRow(a, itemId)));
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

