/**
 * The Plaid client this application uses.
 *
 * Production, with the profile's keys — the only kind the product has. The
 * companion to default-database.ts: assembled once, here, and handed by each
 * interface to the services it calls. A service never imports this; it is
 * given a client, which is what lets a test give it a different one.
 *
 * The keys are read each time they are needed rather than once, so a process
 * that starts before any keys exist (the desktop app, before setup) or outlives
 * a change of keys picks up the current pair on its next call. When there are
 * none, the config layer's own message is what the caller sees.
 */

import { get, getSecret } from "../config.js";
import { PlaidClient } from "./plaid.client.js";

export const plaid = new PlaidClient({
  credentials: () => ({ clientId: get("plaidClientId"), secret: getSecret("plaidSecret") }),
});
