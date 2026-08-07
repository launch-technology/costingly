/**
 * Drive `runInit` end to end with injected streams, against the REAL Plaid
 * sandbox API. Verifies the whole flow, not just the file helpers.
 */

import { fileURLToPath } from "node:url";

/** Repo root, derived from this file — no absolute paths baked in. */
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");


import { PassThrough } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


// Real sandbox credentials, read from the sandbox profile rather than injected
// into the environment — init must be exercised through its normal path.
const SANDBOX_CONFIG = `${P}/.dev-sandbox/config.json`;
if (!existsSync(SANDBOX_CONFIG)) {
  console.log("");
  console.log("SKIPPED — this suite needs the sandbox profile.");
  console.log("");
  console.log("  npm run setup:sandbox");
  console.log("");
  console.log("  It asks for your Plaid SANDBOX keys (dashboard.plaid.com/developers/keys)");
  console.log("  and writes .dev-sandbox/config.json, which is git-ignored. Sandbox is a");
  console.log("  contributor-only concern — nothing about it ships to users.");
  console.log("");
  process.exit(0);
}
const sandbox = JSON.parse(readFileSync(SANDBOX_CONFIG, "utf8"));
const REAL_ID: string = sandbox.plaidClientId;
const REAL_SECRET: string = sandbox.plaidSecret;
process.env["PLAID_ENV"] = "sandbox";

const dir = await mkdtemp(join(tmpdir(), "costingly-initflow-"));
// Keep every run inside the scratch tree: config, database, everything.
//
// COSTINGLY_HOME is the ONLY thing needed now that one profile holds both the
// config and the cluster. It must be set before importing anything — without it
// these runs would write to the real profile and destroy live credentials.
process.env["COSTINGLY_HOME"] = join(dir, "profile");

const { runInit } = await import("../cli/init.js");
const { readConfigFile } = await import("../src/config.js");
const { configPath } = await import("../src/profile.js");
const { closeDb } = await import("../src/db/client.js");

/** Where init will write: `<COSTINGLY_HOME>/config.json`. */
const configIn = (): string => configPath();
const readConfig = async (_p?: string) => readConfigFile();

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else { fail++; out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

const ENTER = "\r";

/** Run init, feeding `keys` as the prompts appear. Returns what it printed. */
async function drive(keys: string[]): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = "";
  output.on("data", (c: Buffer) => { seen += c.toString(); });

  const pending = runInit({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });

  for (const key of keys) {
    await new Promise((r) => setImmediate(r));
    input.write(key);
  }
  await pending;
  return seen.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

// --- 1. happy path on a clean machine -------------------------------------
const target = configIn();
ok(target.startsWith(dir), `SAFETY: target must be inside the scratch dir, got ${target}`);
ok(!existsSync(target), "starts with no config file");

// client_id, secret, then decline the database so this check stays fast
const first = await drive([REAL_ID, ENTER, REAL_SECRET, ENTER, "n", ENTER]);
ok(first.includes("Plaid accepted the credentials"), "verifies credentials against the real Plaid API");
ok(first.includes("Generated an encryption key"), "generates a key when none exists");
ok(existsSync(target), `wrote ${target}`);

const written = await readConfig(target);
eq(written.plaidClientId, REAL_ID, "client_id saved");
eq(written.plaidSecret, REAL_SECRET, "secret saved");
ok(Boolean(written.encryptionKey), "encryption key saved");
eq(Buffer.from(written.encryptionKey!, "base64").length, 32, "key is 32 bytes");
eq((await stat(target)).mode & 0o777, 0o600, "config written owner-only");
eq(written.plaidEnv, "production",
   "init always writes production — sandbox is not a product concept");

// --- 2. re-running must not destroy the key -------------------------------
const keyBefore = written.encryptionKey;
const second = await drive([ENTER, ENTER, "n", ENTER]); // keep both values
ok(second.includes("Keeping the existing encryption key"), "says it is keeping the key");
eq((await readConfig(target)).encryptionKey, keyBefore,
   "RE-RUNNING NEVER REPLACES THE ENCRYPTION KEY");
eq((await readConfig(target)).plaidClientId, REAL_ID, "empty input keeps the existing client_id");

// --- 3. bad credentials write nothing -------------------------------------
process.env["COSTINGLY_HOME"] = join(dir, "profile2");
const cleanTarget = configIn();
ok(cleanTarget.startsWith(dir), "SAFETY: second target is also inside the scratch dir");
const third = await drive([REAL_ID, ENTER, "totally-wrong-secret", ENTER]);
ok(third.includes("rejected") || third.includes("Nothing was written"), "bad credentials are rejected");
ok(!existsSync(cleanTarget), "NOTHING is written when verification fails");

// --- 4. the secret never appears in the output ----------------------------
ok(!first.includes(REAL_SECRET), "the secret is never echoed to the terminal");

await closeDb();
await rm(dir, { recursive: true, force: true });

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
