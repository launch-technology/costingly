/**
 * Whether Plaid credentials are available, and what to say when they are not.
 *
 * App-side: it names Plaid, the Plaid dashboard, and the extension settings
 * screen. Nothing generic survives extraction here.
 */

import { get, getSecretIfSet } from "../../../domain/config.js";

/**
 * What to say when Plaid credentials are missing.
 *
 * Tier 2: the model cannot fix this and must not retry. A bundled install has no
 * terminal, so the only place a user can supply these is the extension's own
 * settings — naming that screen is the entire value of this message.
 */
export const MISSING_CREDENTIALS =
    "costingly has no Plaid credentials, so it cannot connect to a bank yet. This is " +
    "a setup step, not a problem with the request — retrying will not help.\n\n" +
    "Tell the user to do both of these, in order:\n\n" +
    "  1. Open Claude Desktop's settings, find the costingly extension, and enter " +
    "BOTH the Plaid client ID and the secret from dashboard.plaid.com. Half-filled " +
    "is the same as empty here.\n" +
    "  2. Fully quit Claude Desktop (Cmd-Q) and reopen it. Closing the window is not " +
    "enough.\n\n" +
    "Step 2 is required, not optional: the credentials are read when costingly " +
    "starts, so a copy that is already running can never see values entered after " +
    "it launched. If they enter the keys and ask again without restarting, they will " +
    "get this same message.\n\n" +
    "The credentials stay on their machine and are never sent to you.";

/**
 * Are both Plaid credentials available from anywhere?
 *
 * `get()` throws when a value is unset — which is right for a command that
 * cannot continue, and wrong here, where absence is a normal state with a
 * specific answer.
 */
export function credentialsPresent(): boolean {
    try {
        return get("plaidClientId").trim() !== "" && getSecretIfSet("plaidSecret") !== undefined;
    } catch {
        return false;
    }
}
