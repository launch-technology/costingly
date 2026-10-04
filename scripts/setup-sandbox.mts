/**
 * Save the Plaid SANDBOX keys the test suites use.
 *
 *   npm run setup:sandbox
 *
 * Sandbox is a CONTRIBUTOR concern, not a product feature — which is why this
 * is a repo script and not a `costingly` command. Someone who installs costingly
 * should never encounter the word, and cannot reach the sandbox: the product
 * has no setting for it.
 *
 * What this writes, `.dev-sandbox/config.json`, is a keys file for tests. The
 * suites that need a Plaid which will link a bank with nobody in a browser
 * read the keys from it, build their own Plaid client in sandbox mode, and
 * hand that client to the code under test. Nothing in src/ ever looks here.
 *
 * In CI the keys arrive as PLAID_SANDBOX_CLIENT_ID and PLAID_SANDBOX_SECRET —
 * names of their own, on purpose, so they can never be mistaken for the keys
 * the product reads (PLAID_CLIENT_ID and PLAID_SECRET).
 *
 * Lives in scripts/ rather than cli/ so it is not part of the published package
 * — `files` in package.json ships dist/, migrations/ and public/ only.
 */

import { intro, outro, text, password, isCancel, cancel, log } from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PROFILE = resolve(process.cwd(), ".dev-sandbox");

// Set before importing anything that resolves the profile.
process.env["COSTINGLY_HOME"] = PROFILE;

const { writeConfig, readConfigFile } = await import("../src/domain/config.js");
const { platform } = await import("../src/domain/project.js");
const { generateEncryptionKey } = await import("../src/domain/crypto.js");
const { createLinkToken } = await import("../src/domain/services/banks/link.service.js");
const { describeError, PlaidClient } = await import("../src/domain/data/plaid.client.js");

intro("costingly sandbox keys");

const existing = readConfigFile();
if (Object.keys(existing).length > 0) {
  log.info(`Updating ${platform.displayPath(platform.configPath())}`);
} else {
  log.info(`Will create ${platform.displayPath(platform.configPath())}`);
}

log.message(
  "Sandbox credentials come from the same Plaid dashboard as production,\n" +
    "but from the Sandbox row:  https://dashboard.plaid.com/developers/keys",
);

// --- credentials ------------------------------------------------------------
// Environment variables win, so CI can run this unattended. Test-only names:
// these are not the variables the product reads its keys from.
let clientId = process.env["PLAID_SANDBOX_CLIENT_ID"] ?? "";
let secret = process.env["PLAID_SANDBOX_SECRET"] ?? "";

if (!clientId) {
  const answer = await text({
    message: "Plaid client_id",
    placeholder: existing.plaidClientId ? "(press enter to keep the current one)" : "",
    validate: (value) => {
      const supplied = value?.trim() ?? "";
      if (supplied === "" && existing.plaidClientId) return undefined;
      if (supplied === "") return "Required.";
      return undefined;
    },
  });
  if (isCancel(answer)) {
    cancel("Cancelled. Nothing was written.");
    process.exit(1);
  }
  clientId = answer.trim() === "" ? (existing.plaidClientId ?? "") : answer.trim();
}

if (!secret) {
  const answer = await password({
    message: existing.plaidSecret ? "Plaid SANDBOX secret (enter to keep)" : "Plaid SANDBOX secret",
    validate: (value) => {
      const supplied = value?.trim() ?? "";
      if (supplied === "" && existing.plaidSecret) return undefined;
      if (supplied === "") return "Required.";
      return undefined;
    },
  });
  if (isCancel(answer)) {
    cancel("Cancelled. Nothing was written.");
    process.exit(1);
  }
  secret = answer.trim() === "" ? (existing.plaidSecret ?? "") : answer.trim();
}

// --- verify against the real sandbox API ------------------------------------
// Same check `costingly init` makes, against a client built here in sandbox
// mode. Catching a production secret pasted into the sandbox slot here beats a
// confusing failure inside the test suite.
try {
  await createLinkToken(PlaidClient.withKeys(clientId, secret, "sandbox"));
  log.success("Plaid accepted the sandbox credentials");
} catch (error) {
  cancel(
    `Plaid rejected the credentials:\n  ${describeError(error)}\n\n` +
      `Make sure you used the SANDBOX secret, not the production one.\n` +
      `Nothing was written.`,
  );
  process.exit(1);
}

// --- write ------------------------------------------------------------------
// The key is throwaway and never encrypts anything real, but it is generated
// the same way so the tests exercise the genuine crypto path.
const encryptionKey = existing.encryptionKey ?? generateEncryptionKey();

await writeConfig({
  plaidClientId: clientId,
  plaidSecret: secret,
  encryptionKey,
});

log.success(`Wrote ${platform.displayPath(platform.configPath())}  (mode 0600, git-ignored)`);
log.info(
  "These keys are used only by the test suites, which build their own sandbox\n" +
    "Plaid client from them. The product never reads this file.",
);

outro("Now run the end-to-end tests.");

// A guard against the one mistake that would matter: this must never be the
// profile a normal command picks up.
if (!existsSync(PROFILE)) {
  console.error("Expected the profile directory to exist after writing. Check permissions.");
  process.exit(1);
}
