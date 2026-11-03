/**
 * Linking and reconnecting a bank, worded for a model.
 *
 * Neither tool can finish its own job: Plaid's login runs in a real browser,
 * on the page the app serves. So the whole of what these say is an address,
 * what will happen there, and what to do afterwards — plus whatever finished
 * in the browser since the last call, which is the only moment there is to
 * report it.
 *
 * Everything that is wrong points at the app. The keys are entered on the
 * Settings screen; the database is started from the Status screen. Nothing
 * here names a command or Claude Desktop.
 */

import type { ItemSummary } from "../../../../../domain/data/repositories/items.repository.js";
import type { LinkedItem } from "../../../../../domain/services/banks/link.service.js";
import type { RepairedItem } from "../../../../../domain/services/banks/link-session.service.js";

/** No Plaid keys: the one thing no tool can supply. */
export const MISSING_KEYS =
  "costingly has no Plaid keys yet, so it cannot connect to a bank. This is a setup " +
  "step, not a problem with the request — retrying will not help.\n\n" +
  "Tell the user to open Costingly's Settings screen and enter BOTH the Plaid client ID " +
  "and the secret from dashboard.plaid.com. Half-filled is the same as empty. The keys " +
  "take effect at once; nothing needs restarting.\n\n" +
  "The keys stay on their machine and are never sent to you.";

/** The app's web server is not up, so there is no page to open. */
export const PAGE_UNAVAILABLE =
  "The bank-link page is not available right now: the Costingly app's local web server " +
  "is not running. Tell the user to open Costingly's Status screen, where the MCP " +
  "endpoint section says why and offers Try again.";

export function linkInstructions(address: string, linkedSince: LinkedItem[]): string {
  const already =
    linkedSince.length === 0
      ? ""
      : "Since we last spoke, these were connected:\n" +
        linkedSince
          .map((i) => `  ${i.institutionName ?? "(unknown bank)"} — ${i.accountCount} account(s)`)
          .join("\n") +
        "\n\nCall sync to pull their transactions.\n\n";

  return (
    already +
    `Ask the user to open this page in their browser:\n\n  ${address}\n\n` +
    "They can connect as many banks as they like from it. The page is served by the " +
    "Costingly app on their own machine and is not reachable from the network.\n\n" +
    "When they say they are finished, call sync."
  );
}

export function relinkInstructions(address: string, bankName: string, repairedSince: RepairedItem[]): string {
  const already =
    repairedSince.length === 0
      ? ""
      : "Since we last spoke, these connections were repaired:\n" +
        repairedSince.map((r) => `  ${r.institutionName ?? r.itemId}`).join("\n") +
        "\n\nCall sync to catch up on what they missed.\n\n";

  return (
    already +
    `Ask the user to open this page and sign in to ${bankName} again:\n\n  ${address}\n\n` +
    "This repairs the existing connection — their transaction history is kept and " +
    "nothing is re-downloaded. The page is served by the Costingly app on their own " +
    "machine and is not reachable from the network.\n\n" +
    "When they say they have signed in, call sync to catch up on anything missed " +
    "while the connection was down."
  );
}

/** An id that names no bank, with the banks that exist so the model can pick again. */
export function unknownBank(itemId: string, known: ItemSummary[], none: string): string {
  const list =
    known.length === 0
      ? none
      : "Connected banks:\n" + known.map((i) => `  ${i.itemId}  ${i.institutionName ?? "(unknown bank)"}  [${i.status}]`).join("\n");
  return `No bank has item_id "${itemId}".\n\n${list}`;
}
