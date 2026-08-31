/**
 * Create the `.dev-sandbox` profile used by the end-to-end tests.
 *
 *   npm run setup:sandbox
 *
 * Sandbox is a CONTRIBUTOR concern, not a product feature — which is why this
 * is a repo script and not a `costingly` command. Someone who installs costingly
 * should never encounter the word.
 *
 * `costingly init` deliberately always writes `plaidEnv: "production"`, so it
 * cannot create this profile. Everything else about the profile is identical to
 * a real one: same writer, same validation, same file mode. Only the Plaid
 * environment and the throwaway encryption key differ.
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
process.env["PLAID_ENV"] = "sandbox";

const { writeConfig, readConfigFile } = await import("../src/core/config.js");
const { configPath, displayPath } = await import("../src/core/profile.js");
const { generateEncryptionKey } = await import("../src/core/crypto.js");
const { createLinkToken } = await import("../src/services/banks/link.service.js");
const { describeError } = await import("../src/data/plaid.client.js");

intro("costingly sandbox profile");

const existing = readConfigFile();
if (Object.keys(existing).length > 0) {
  log.info(`Updating ${displayPath(configPath())}`);
} else {
  log.info(`Will create ${displayPath(configPath())}`);
}

log.message(
  "Sandbox credentials come from the same Plaid dashboard as production,\n" +
    "but from the Sandbox row:  https://dashboard.plaid.com/developers/keys",
);

// --- credentials ------------------------------------------------------------
// Environment variables win, so CI can run this unattended.
let clientId = process.env["PLAID_CLIENT_ID"] ?? "";
let secret = process.env["PLAID_SECRET"] ?? "";

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
// Same check `costingly init` makes. Catching a production secret pasted into
// the sandbox slot here beats a confusing failure inside the test suite.
process.env["PLAID_CLIENT_ID"] = clientId;
process.env["PLAID_SECRET"] = secret;
delete (globalThis as Record<string, unknown>)["__costinglyClient"];

try {
  await createLinkToken();
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
  plaidEnv: "sandbox",
});

log.success(`Wrote ${displayPath(configPath())}  (mode 0600, git-ignored)`);
log.info(
  "This profile has its own cluster and its own encryption key, so it cannot\n" +
    "read or write your real transactions.",
);

outro("Now run the end-to-end tests.");

// A guard against the one mistake that would matter: this must never be the
// profile a normal command picks up.
if (!existsSync(PROFILE)) {
  console.error("Expected the profile directory to exist after writing. Check permissions.");
  process.exit(1);
}
