/**
 * Runtime smoke test — things `tsc` cannot prove:
 *  - every module actually loads under Node ESM (CJS interop for `pg`)
 *  - crypto round-trips and rejects tampering
 *  - config validation behaves
 * No database or Plaid credentials required.
 */
process.env.ENCRYPTION_KEY ??= "";

const results: string[] = [];
let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL  ${name}\n          ${error instanceof Error ? error.message : error}`);
  }
}

/** Same, for assertions that must await. A rejected promise passed to check()
 *  would be swallowed and silently counted as a pass. */
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL  ${name}\n          ${error instanceof Error ? error.message : error}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function throws(fn: () => unknown, fragment: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(fragment), `expected error containing "${fragment}", got "${message}"`);
    return;
  }
  throw new Error(`expected a throw containing "${fragment}", but nothing was thrown`);
}

// --- module loading -------------------------------------------------------
const dbModule = await import("../src/domain/data/default-database.js");
const crypto = await import("../src/domain/crypto.js");
const configMod = await import("../src/domain/config.js");
const index = await import("../src/index.js");
const project = await import("../src/domain/project.js");

check("all modules load under Node ESM", () => {
  assert(typeof dbModule.db.query === "function", "db.query missing");
  assert(typeof dbModule.db.transaction === "function", "db.transaction missing");
  assert(typeof project.server.clusterDir === "function", "server.clusterDir missing");
  assert(typeof project.server.ensureRunning === "function", "server.ensureRunning missing");
  assert(typeof index.syncAllItems === "function", "syncAllItems not exported from index");
  assert(typeof index.createLinkToken === "function", "createLinkToken not exported from index");
  assert(typeof configMod.getSecret === "function", "config.getSecret missing");
  assert(typeof configMod.describeConfig === "function", "config.describeConfig missing");
});

check("the removed surface is really gone", () => {
  // Each of these had branches in several files; a lingering export means a
  // caller somewhere was missed.
  for (const name of [
    "usingRemoteDatabase", "dataDir", "costinglyHome", "config",
    "setValue", "has", "configLocation", "safeEqual",
  ]) {
    assert(!(name in index), `src/index.ts still exports ${name}`);
  }
});

// --- crypto ---------------------------------------------------------------
const key = crypto.generateEncryptionKey();

check("generateEncryptionKey produces a 32-byte base64 key", () => {
  assert(Buffer.from(key, "base64").length === 32, `expected 32 bytes, got ${Buffer.from(key, "base64").length}`);
});

process.env.ENCRYPTION_KEY = key;

check("encrypt -> decrypt round-trips", () => {
  const secret = "access-sandbox-11111111-2222-3333-4444-555555555555";
  const enc = crypto.encrypt(secret);
  assert(enc.split(".").length === 3, `expected iv.tag.ciphertext, got "${enc}"`);
  assert(!enc.includes(secret), "plaintext leaked into ciphertext");
  assert(crypto.decrypt(enc) === secret, "round-trip mismatch");
});

check("same plaintext encrypts differently each time (random IV)", () => {
  const a = crypto.encrypt("same");
  const b = crypto.encrypt("same");
  assert(a !== b, "ciphertexts identical — IV is not random");
  assert(crypto.decrypt(a) === "same" && crypto.decrypt(b) === "same", "round-trip mismatch");
});

check("tampered ciphertext is rejected (GCM auth)", () => {
  const enc = crypto.encrypt("tamper me");
  const [iv, tag, ct] = enc.split(".");
  const bytes = Buffer.from(ct!, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  throws(
    () => crypto.decrypt(`${iv}.${tag}.${bytes.toString("base64")}`),
    "authentication failed",
  );
});

check("wrong key is rejected", () => {
  const enc = crypto.encrypt("secret");
  process.env.ENCRYPTION_KEY = crypto.generateEncryptionKey();
  throws(() => crypto.decrypt(enc), "authentication failed");
  process.env.ENCRYPTION_KEY = key;
});

check("malformed payload is rejected", () => {
  throws(() => crypto.decrypt("not-encrypted"), "3 dot-separated parts");
});

check("bad key length is rejected", () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
  throws(() => crypto.encrypt("x"), "32 bytes");
  process.env.ENCRYPTION_KEY = key;
});

// Config and profile resolution have their own suites (config.mts,
// profile.mts). This file stays what its header claims: does everything load,
// and does crypto behave.

console.log(results.join("\n"));
console.log(failures === 0 ? `\nAll ${results.length} checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
