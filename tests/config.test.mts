/**
 * src/config.ts — the config.json store.
 *
 * The assertions that matter most, in order:
 *   1. a corrupt file is NEVER treated as "no config" — that would send the user
 *      to `init` to overwrite the only copy of their encryption key
 *   2. the file is written 0600, atomically
 *   3. secrets are never rendered by the diagnostic path
 */

import { fileURLToPath } from "node:url";

/** Repo root, derived from this file — no absolute paths baked in. */
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");


const cfg = await import("../src/config.js");
const { configPath } = await import("../src/profile.js");
const { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

async function throwsWith(fn: () => unknown, fragment: string, what: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ok(message.includes(fragment), `${what} (message contains "${fragment}")`);
    return;
  }
  eq("no throw", `throw containing "${fragment}"`, what);
}

const dir = await mkdtemp(join(tmpdir(), "costingly-config-"));
process.env["COSTINGLY_HOME"] = dir;
for (const k of ["PLAID_CLIENT_ID", "PLAID_SECRET", "ENCRYPTION_KEY", "PLAID_ENV", "PORT"]) {
  delete process.env[k];
}

const SAMPLE = {
  plaidClientId: "client-abc",
  plaidSecret: "secret-xyz",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  plaidEnv: "production" as const,
  port: 4000,
};

// --- nothing set up --------------------------------------------------------
eq(cfg.readConfigFile(), {}, "a missing config file reads as empty, not an error");
await throwsWith(() => cfg.getSecret("plaidSecret"), "costingly init",
  "a missing secret points at the fix");
await throwsWith(() => cfg.getSecret("plaidSecret"), dir,
  "and names the profile it checked");

// Defaults still resolve with no file at all — help and doctor must work.
eq(cfg.get("plaidEnv"), "production", "plaidEnv defaults to production");
eq(cfg.get("port"), 4000, "port defaults to 4000");

// --- writing ---------------------------------------------------------------
await cfg.writeConfig(SAMPLE);
eq((await stat(configPath())).mode & 0o777, 0o600, "config.json is written owner-only (0600)");
eq(cfg.readConfigFile(), SAMPLE, "round-trips every key");
eq(cfg.get("plaidClientId"), "client-abc", "get() reads a public value");
eq(cfg.getSecret("plaidSecret"), "secret-xyz", "getSecret() reads a secret");

// No temp file left behind by the atomic write.
const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
eq(leftovers, [], "the atomic write leaves no temp file");

// --- precedence: environment beats the file --------------------------------
process.env["PLAID_SECRET"] = "from-the-environment";
eq(cfg.getSecret("plaidSecret"), "from-the-environment", "environment overrides the file");
eq(cfg.describeConfig().find((v) => v.key === "plaidSecret")?.source, "environment",
   "and the source is reported as the environment");
delete process.env["PLAID_SECRET"];
eq(cfg.getSecret("plaidSecret"), "secret-xyz", "the file wins again once it is unset");

// A blank environment variable must not shadow a real stored value.
process.env["PLAID_SECRET"] = "   ";
eq(cfg.getSecret("plaidSecret"), "secret-xyz", "a blank env var is ignored, not treated as empty");
delete process.env["PLAID_SECRET"];

// --- rewriting preserves everything else -----------------------------------
// `init` re-runs through writeConfig, so a rewrite must not disturb the key.
await cfg.writeConfig({ ...SAMPLE, port: 4100 });
eq(cfg.get("port"), 4100, "a rewrite updates the key it changed");
eq(cfg.getSecret("encryptionKey"), SAMPLE.encryptionKey,
   "A REWRITE DOES NOT DISTURB THE ENCRYPTION KEY");
eq(cfg.readConfigFile().plaidClientId, "client-abc", "and leaves other keys alone");
eq((await stat(configPath())).mode & 0o777, 0o600, "still 0600 after a rewrite");

// --- validation ------------------------------------------------------------
process.env["PORT"] = "not-a-number";
await throwsWith(() => cfg.get("port"), "Invalid port", "a non-numeric port is rejected");
process.env["PORT"] = "70000";
await throwsWith(() => cfg.get("port"), "Invalid port", "an out-of-range port is rejected");
delete process.env["PORT"];

process.env["PLAID_ENV"] = "development";
await throwsWith(() => cfg.get("plaidEnv"), "sandbox", "a retired plaidEnv is rejected by name");
delete process.env["PLAID_ENV"];

// --- secrets are never rendered --------------------------------------------
const described = cfg.describeConfig();
const secretRow = described.find((v) => v.key === "plaidSecret");
eq(secretRow?.display, "set (hidden)", "describeConfig hides the secret value");
ok(!JSON.stringify(described).includes("secret-xyz"),
   "THE SECRET NEVER APPEARS IN DIAGNOSTIC OUTPUT");
ok(!JSON.stringify(described).includes(SAMPLE.encryptionKey),
   "nor does the encryption key");
eq(described.find((v) => v.key === "plaidClientId")?.display, "client-abc",
   "but non-secrets are shown in full");

// --- a corrupt file must NOT look like "no config" -------------------------
// Silently returning {} would send the user to `costingly init`, which would
// overwrite a file that may hold the only copy of their encryption key.
await writeFile(configPath(), "{ this is not json");
await throwsWith(() => cfg.readConfigFile(), "Could not read",
  "corrupt JSON is a hard error, not an empty config");
await throwsWith(() => cfg.readConfigFile(), "do NOT delete it",
  "and warns against deleting the file");

// A JSON array is valid JSON but not a config object.
await writeFile(configPath(), "[1,2,3]");
await throwsWith(() => cfg.readConfigFile(), "Could not read", "a JSON array is rejected too");

// --- profile isolation -----------------------------------------------------
const other = await mkdtemp(join(tmpdir(), "costingly-config2-"));
process.env["COSTINGLY_HOME"] = other;
eq(cfg.readConfigFile(), {}, "a different profile sees a different (empty) config");
eq(cfg.readConfigFile().plaidClientId, undefined, "PROFILES ARE FULLY ISOLATED");

// ---------------------------------------------------------------------------
// updateConfigSync, and the encryption key creating itself
// ---------------------------------------------------------------------------
// A bundled install has no terminal, so there is no `costingly init` to generate
// an encryption key. It has to appear on first use — and it has to appear
// exactly once, because a second one would orphan every stored access token.

const keyDir = await mkdtemp(join(tmpdir(), "costingly-key-"));
process.env["COSTINGLY_HOME"] = keyDir;
for (const name of ["PLAID_CLIENT_ID", "PLAID_SECRET", "ENCRYPTION_KEY", "PLAID_ENV", "PORT"]) {
  delete process.env[name];
}

// A pre-existing file whose other values must survive the merge.
await writeFile(configPath(), JSON.stringify({ plaidClientId: "abc", port: 4321 }), "utf8");

const crypto = await import(`${P}/src/crypto.js?key-test`);

eq(cfg.getSecretIfSet("encryptionKey"), undefined, "no encryption key to begin with");

const sealed = crypto.encrypt("a-plaid-access-token");
const stored = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, string | number>;

ok(typeof stored["encryptionKey"] === "string", "ENCRYPTING WITHOUT A KEY CREATES ONE");
eq(Buffer.from(String(stored["encryptionKey"]), "base64").length, 32, "and it is 32 bytes");
eq(stored["plaidClientId"], "abc", "the merge preserves other values in the file");
eq(stored["port"], 4321, "including non-secrets");
eq(crypto.decrypt(sealed), "a-plaid-access-token", "and the value round-trips");

// The property that matters: stable across calls. A key regenerated on the
// second call would make every previously stored token undecryptable.
const firstKey = String(stored["encryptionKey"]);
crypto.encrypt("second");
const after = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, string>;
eq(after["encryptionKey"], firstKey, "A SECOND CALL REUSES THE KEY, never regenerates it");

const keyMode = await stat(configPath());
eq(keyMode.mode & 0o777, 0o600, "the file written by updateConfigSync is still 0600");

// An environment value is a per-invocation override, not state. Persisting one
// would silently turn a temporary setting into a permanent one.
process.env["PLAID_SECRET"] = "from-the-environment";
cfg.updateConfigSync({ plaidEnv: "sandbox" });
const afterEnv = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, string>;
eq(afterEnv["plaidEnv"], "sandbox", "updateConfigSync writes what it was given");
eq(afterEnv["plaidSecret"], undefined,
   "AND NEVER PERSISTS A VALUE THAT CAME FROM THE ENVIRONMENT");
delete process.env["PLAID_SECRET"];

await rm(keyDir, { recursive: true, force: true });

await rm(dir, { recursive: true, force: true });
await rm(other, { recursive: true, force: true });
delete process.env["COSTINGLY_HOME"];

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
