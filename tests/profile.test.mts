/**
 * The profile — where a project keeps everything it owns.
 *
 * The assertion that matters most: the profile must be ONE directory, and the
 * home variable must move all of it.
 *
 * Exercised through costingly's own identity, and through a SECOND identity
 * resolved from a fake environment — which is what proves the platform is
 * genuinely project-agnostic rather than costingly with the name extracted.
 */

const { resolvePlatform } = await import("../src/platform/platform-config.js");
const { costingly } = await import("../src/domain/project.js");

const config = resolvePlatform(costingly);
const profileDir = (): string => config.profileDir();
const profileSource = (): string => config.profileSource();
const configPath = (): string => config.configPath();
const displayPath = (p: string): string => config.displayPath(p);
const APP_NAME = costingly.name;

const { homedir, platform } = await import("node:os");
const { basename, join, resolve, isAbsolute, sep } = await import("node:path");

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
eq(profileSource(), "home variable", "reports the home variable as the source");
eq(config.homeVar, "COSTINGLY_HOME", "and the variable is named after the project");
eq(configPath(), join(resolve("/tmp/profile-unit"), "config.json"), "config.json lives inside the profile");

// --- the profile's NAME ----------------------------------------------------
// What a destructive command makes you type, so it has to identify THIS
// profile and no other.
eq(config.profileName(), "profile-unit", "an overridden profile is named for its directory");
process.env["COSTINGLY_HOME"] = "/tmp/another-one";
eq(config.profileName(), "another-one", "and follows the variable when it moves");

// The reason this is not simply basename(profileDir()). On Windows the
// platform default ends in a generic component — .../costingly/Data — which
// names nothing and would be identical for every project on the machine.
delete process.env["COSTINGLY_HOME"];
eq(config.profileName(), APP_NAME, "the default profile is named for the project");
if (platform() === "win32") {
  eq(basename(profileDir()), "Data", "…precisely because the Windows default basename is generic");
  ok(config.profileName() !== basename(profileDir()), "so the name is NOT the directory basename");
}

// A root path has no basename; asking the user to type "" would be unanswerable.
process.env["COSTINGLY_HOME"] = resolve("/");
eq(config.profileName(), APP_NAME, "a root path falls back to the project name");
process.env["COSTINGLY_HOME"] = "/tmp/profile-unit";

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

// ---------------------------------------------------------------------------
// A SECOND PROJECT, resolved from a fake environment
// ---------------------------------------------------------------------------
//
// The point of the whole platform/domain split: nothing below the domain names
// costingly. If this block ever needs a change under platform/ to keep passing,
// something project-specific has leaked back in.
//
// The environment is PASSED, not mutated — two configs coexist in one process,
// which the module-level profile this replaced could not do.

const other = resolvePlatform(
  { name: "drive-rag", ports: { database: 55000 } },
  { DRIVE_RAG_HOME: "/tmp/drive-rag-profile" },
);

eq(other.homeVar, "DRIVE_RAG_HOME", "a second project gets its OWN home variable");
eq(other.databaseName, "drive-rag", "and its own database name");
eq(other.profileDir(), resolve("/tmp/drive-rag-profile"),
   "and its own profile, from an environment this process never had");
eq(other.profileSource(), "home variable", "reported as chosen by that variable");
ok(!other.profileDir().includes("costingly"),
   "TWO PROJECTS SHARE NO STATE — the platform names neither of them");

// The first config is untouched by the second existing.
eq(config.homeVar, "COSTINGLY_HOME", "resolving another project changes nothing here");

if (saved === undefined) delete process.env["COSTINGLY_HOME"];
else process.env["COSTINGLY_HOME"] = saved;

console.log(out.join("\n"));
console.log(`\n  default profile: ${displayPath(dflt)}`);
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
