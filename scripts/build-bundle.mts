/**
 * Build the installable MCP bundle:  npm run build:bundle
 *
 * Produces `build/costingly-<version>.mcpb` — a zip Claude Desktop installs on a
 * double-click, containing the built code, the migrations, and a production-only
 * node_modules including this platform's embedded PostgreSQL.
 *
 * THE STAGING DIRECTORY
 *
 * The one part that is not obvious. npm hoists dependencies flat, so the repo's
 * node_modules is production and development packages mixed together with no
 * reliable way to tell them apart — `esbuild` is in there because `tsx` needs
 * it, and there is a tail of others that no hand-maintained exclusion list would
 * survive. The only dependable way to get production-only dependencies is to let
 * npm resolve them into a directory that has none, which is what staging is.
 *
 * WHY IT IS THIS BIG
 *
 * `@embedded-postgres/*` is ~144 MB, and `mcpb pack` dereferences symlinks — the
 * seventeen dylib symlinks in PostgreSQL's lib directory become real copies, so
 * the archive is roughly twice the package. That is a genuine cost of shipping a
 * database inside an extension, not a bug in the build.
 */

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const STAGING = join(BUILD, "staging");
const MCPB = join(ROOT, "node_modules", ".bin", "mcpb");

/** Copied into the bundle verbatim. Everything else is either built or installed. */
const SHIPPED = ["dist", "migrations", "public", "manifest.json"];

function say(step: string, detail = ""): void {
  console.log(`  ${step.padEnd(22)}${detail}`);
}

async function sh(command: string, args: string[], cwd = ROOT): Promise<string> {
  const { stdout } = await run(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function sizeOf(path: string): Promise<string> {
  const bytes = (await stat(path)).size;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const output = join(BUILD, `costingly-${version}.mcpb`);

console.log(`\nBuilding costingly ${version}\n`);

// --- 1. clean -------------------------------------------------------------
await rm(BUILD, { recursive: true, force: true });
await mkdir(STAGING, { recursive: true });
say("clean", "build/");

// --- 2. compile -----------------------------------------------------------
// Claude Desktop runs dist/, never the TypeScript. A stale dist here ships an
// old server that looks correct until it misbehaves.
await sh("npm", ["run", "build"]);
say("compile", "dist/");

// --- 3. production dependencies ------------------------------------------
// npm ci, not install: it installs exactly the lockfile, so the bundle contains
// the same versions that were tested rather than whatever resolved today.
await cp(join(ROOT, "package-lock.json"), join(STAGING, "package-lock.json"));

const manifestPkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<
  string,
  unknown
>;

// `scripts` must go BEFORE the install, not after. npm ci runs `prepare`, and
// this project's prepare compiles TypeScript — which fails in a directory that
// contains no source. Dependencies' own install scripts are unaffected, and they
// matter: @embedded-postgres rehydrates PostgreSQL's dylib symlinks in one.
delete manifestPkg["scripts"];

// devDependencies stay for now even though --omit=dev skips installing them:
// npm ci verifies package.json against the lockfile first, and removing them
// here would fail that check before a single package was fetched.
await writeFile(join(STAGING, "package.json"), `${JSON.stringify(manifestPkg, null, 2)}\n`);

await sh("npm", ["ci", "--omit=dev"], STAGING);
say("dependencies", `production only, ${await du(join(STAGING, "node_modules"))}`);

// --- 4. the payload -------------------------------------------------------
for (const entry of SHIPPED) {
  await cp(join(ROOT, entry), join(STAGING, entry), { recursive: true });
}
say("payload", SHIPPED.join(", "));

// One version, one place. `npm version` bumps package.json and knows nothing
// about manifest.json — and it is the manifest that Claude Desktop displays. Let
// them drift once and you get a bundle called 1.1.0 that reports itself as 1.0.0,
// which is worse than no version at all because it is confidently wrong.
const manifest = JSON.parse(await readFile(join(STAGING, "manifest.json"), "utf8")) as Record<
  string,
  unknown
>;
if (manifest["version"] !== version) {
  say("version", `manifest ${String(manifest["version"])} -> ${version}`);
  manifest["version"] = version;
}
await writeFile(join(STAGING, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Now that npm has finished with it, drop the development dependencies and the
// lockfile. They describe how this was built; the bundle only needs to describe
// what it is.
delete manifestPkg["devDependencies"];
await writeFile(join(STAGING, "package.json"), `${JSON.stringify(manifestPkg, null, 2)}\n`);
await rm(join(STAGING, "package-lock.json"), { force: true });

// --- 5. validate then pack ------------------------------------------------
// Validation first: a manifest error caught here is a build failure, and the
// same error caught by Claude Desktop is a silent install that does nothing.
await sh(MCPB, ["validate", join(STAGING, "manifest.json")]);
say("validate", "manifest.json ok");

const packOutput = await sh(MCPB, ["pack", STAGING, output]);
const files = /total files:\s*(\d+)/.exec(packOutput)?.[1] ?? "?";
const sha = /shasum:\s*(\S+)/.exec(packOutput)?.[1] ?? "?";

say("pack", `${files} files`);
console.log(`
  ${output}
  ${await sizeOf(output)}   sha1 ${sha}

  Install by opening the file with Claude Desktop.
`);

/** Human-readable directory size, via du — cheaper than walking it in Node. */
async function du(path: string): Promise<string> {
  const out = await sh("du", ["-sh", path]);
  return `${out.split("\t")[0]?.trim() ?? "?"}B`.replace("MB", "M").replace("GB", "G");
}
