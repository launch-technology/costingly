/**
 * src/profile.ts — where costingly keeps everything it owns.
 *
 * The assertion that matters most: the profile must be ONE directory, and
 * COSTINGLY_HOME must move all of it.
 */

import { fileURLToPath } from "node:url";

/** Repo root, derived from this file — no absolute paths baked in. */
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");


const { profileDir, profileSource, configPath, displayPath, APP_NAME } = await import(
  new URL("../src/core/profile.js", import.meta.url).href
);
const { homedir, platform } = await import("node:os");
const { join, resolve, isAbsolute, sep } = await import("node:path");

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

const saved = process.env["COSTINGLY_HOME"];
delete process.env["COSTINGLY_HOME"];

// --- platform default -----------------------------------------------------
const dflt = profileDir();
eq(profileSource(), "platform default", "reports the platform default when unset");
ok(dflt.includes(APP_NAME), `profile is app-scoped: ${dflt}`);
ok(!dflt.includes("-nodejs"), "env-paths' -nodejs suffix is suppressed");

if (platform() === "darwin") {
  eq(dflt, join(homedir(), "Library", "Application Support", "costingly"),
     "macOS: ~/Library/Application Support/costingly");
}

// The reaped-directory trap: /var/folders is cleaned by macOS, which would
// destroy a live socket directory out from under the postmaster.
ok(!dflt.startsWith("/var/folders"), "profile is NOT under the reaped temp directory");
ok(!dflt.startsWith("/tmp"), "profile is NOT under /tmp");

// --- the socket has to fit in sockaddr_un ---------------------------------
const socketPath = join(dflt, "pg18-run", ".s.PGSQL.5432");
const limit = platform() === "darwin" ? 104 : 108;
ok(Buffer.byteLength(socketPath) < limit,
   `socket path fits: ${Buffer.byteLength(socketPath)} of ${limit} bytes`);

// --- COSTINGLY_HOME moves EVERYTHING --------------------------------------
process.env["COSTINGLY_HOME"] = "/tmp/profile-unit";
eq(profileDir(), resolve("/tmp/profile-unit"), "COSTINGLY_HOME overrides the platform default");
eq(profileSource(), "COSTINGLY_HOME", "reports COSTINGLY_HOME as the source");
eq(configPath(), join(resolve("/tmp/profile-unit"), "config.json"), "config.json lives inside the profile");

// A relative value must not follow the process around.
process.env["COSTINGLY_HOME"] = "./.dev";
ok(isAbsolute(profileDir()), `relative COSTINGLY_HOME is made absolute: ${profileDir()}`);
eq(profileDir(), join(process.cwd(), ".dev"), "resolved against the current directory");

// Whitespace-only is treated as unset, not as a path.
process.env["COSTINGLY_HOME"] = "   ";
eq(profileSource(), "platform default", "blank COSTINGLY_HOME is ignored");

delete process.env["COSTINGLY_HOME"];

// --- nothing is created on disk -------------------------------------------
const { existsSync } = await import("node:fs");
ok(!existsSync(resolve("/tmp/profile-unit")), "resolving a profile does NOT create it");

// --- display helper --------------------------------------------------------
eq(displayPath(join(homedir(), "x")), `~${sep}x`, "home directory is shortened for display");
eq(displayPath("/opt/elsewhere"), "/opt/elsewhere", "other paths are left alone");

if (saved === undefined) delete process.env["COSTINGLY_HOME"];
else process.env["COSTINGLY_HOME"] = saved;

console.log(out.join("\n"));
console.log(`\n  default profile: ${displayPath(dflt)}`);
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
