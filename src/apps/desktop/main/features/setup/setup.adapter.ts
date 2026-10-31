/**
 * Setup's wiring: the real domain, fitted to what the setup service asks for.
 * WIRING ONLY — the config file, the key generator and the datastore are
 * handed over as they are; the key check is the domain's own link-token call,
 * made with a client built from the typed pair. No Electron.
 */

import { existsSync } from "node:fs";

import { readConfigFile, writeConfig } from "../../../../../domain/config.js";
import { generateEncryptionKey } from "../../../../../domain/crypto.js";
import { PlaidClient } from "../../../../../domain/data/plaid.client.js";
import { platform, server } from "../../../../../domain/project.js";
import { createLinkToken } from "../../../../../domain/services/banks/link.service.js";
import { describeError, keysPresent } from "../../shared/domain.adapter.js";
import { PlaidKeyVerifier } from "./plaid-key-verifier.adapter.js";
import type { SetupDependencies } from "./setup.service.js";

/**
 * The check a pair of typed keys must pass before setup saves it: ask Plaid
 * for a link token with a client built from that pair alone.
 *
 * Production, like everything the app does with Plaid. There is no way to
 * point this elsewhere from outside; the suites that need Plaid's sandbox
 * build their own verifier around their own check.
 */
export function keyCheck(clientId: string, secret: string): Promise<string> {
  return createLinkToken(PlaidClient.withKeys(clientId, secret));
}

/** Everything setup needs except creating the database, which the app supplies. */
export function setupDependencies(): Omit<SetupDependencies, "createDatabase"> {
  return {
    datastore: server,
    keysPresent,
    config: {
      readFile: readConfigFile,
      write: writeConfig,
    },
    keys: new PlaidKeyVerifier({ check: keyCheck }),
    newEncryptionKey: generateEncryptionKey,
    dataFolder: () => platform.displayPath(platform.profileDir()),
    pathExists: existsSync,
    describeError,
  };
}
