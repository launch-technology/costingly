/**
 * Build the Claude Desktop extension:  npm run build:bundle
 *
 * Produces `build/costingly-<version>.mcpb` — a zip Claude Desktop installs on
 * a double-click. It holds ONE program file: src/apps/mcpb bundled by esbuild
 * into mcpb.mjs with everything it imports inside it, plus the manifest and
 * the licence files. No node_modules, no database engine, no migrations: the
 * extension only connects Claude Desktop to the Costingly app, which has all
 * of those.
 *
 * The checks at the end are the point of the script as much as the packing.
 * A bundle that quietly grew a database engine, or whose single file cannot
 * start, would install fine and fail on the user's machine; here it fails the
 * build instead.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const run = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const STAGING = join(BUILD, "staging");
const ENTRY = join(ROOT, "src", "apps", "mcpb", "main.ts");
const BUNDLED = "mcpb.mjs";

/** The whole extension may not be larger than this. Today it is well under. */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

/**
 * The mcpb CLI as a JS file, not the .bin shim.
 *
 * The shim is a symlink on unix and a .cmd batch file on Windows, and Node has
 * refused to spawn .cmd without a shell since the CVE-2024-27980 mitigation.
 * Running the JS with the Node binary already executing this script sidesteps
 * both: no shim, no shell, identical on every platform.
 */
const MCPB_CLI = join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");

/**
 * Copied into the bundle verbatim beside the program file.
 *
 * LICENSE is on this list for a reason, not for tidiness: handing someone a
 * .mcpb is distributing a copy, and MIT requires the notice to travel with the
 * copy. NOTICE is written rather than copied: the repository's one describes
 * the PostgreSQL binaries the desktop app ships, which this bundle does not.
 */
const COPIED = ["manifest.json", "LICENSE"];
const SHIPPED = [...COPIED, "NOTICE"];

function say(step: string, detail = ""): void {
  console.log(`  ${step.padEnd(22)}${detail}`);
}

/** Run a Node script with the interpreter already running this one. */
async function node(script: string, args: string[], cwd = ROOT): Promise<string> {
  const { stdout } = await run(process.execPath, [script, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
const output = join(BUILD, `costingly-${version}.mcpb`);

console.log(`\nBuilding the costingly extension ${version}\n`);

// --- 1. clean -------------------------------------------------------------
// Only what this script makes. build/ is shared with the desktop app's
// installer (build/installer/), which is none of this script's business.
await rm(STAGING, { recursive: true, force: true });
await mkdir(STAGING, { recursive: true });
for (const name of await readdir(BUILD)) {
  if (name.endsWith(".mcpb")) await rm(join(BUILD, name), { force: true });
}
say("clean", "build/staging, build/*.mcpb");

// --- 2. bundle ------------------------------------------------------------
// One ES module with every import inside it, so the extension needs nothing
// beside it. The version is defined in rather than read from a package.json
// that will not be there. The banner gives bundled CommonJS dependencies the
// `require` they expect under an ES module.
await build({
  entryPoints: [ENTRY],
  outfile: join(STAGING, BUNDLED),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  define: { __MCPB_VERSION__: JSON.stringify(version) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // The dependencies' licence comments stay inside the file: the file is the
  // copy of them that is being distributed.
  legalComments: "inline",
  logLevel: "warning",
});
say("bundle", `${BUNDLED}, ${mb(await sizeOf(join(STAGING, BUNDLED)))}`);

// --- 3. the payload -------------------------------------------------------
for (const entry of COPIED) {
  await cp(join(ROOT, entry), join(STAGING, entry), { recursive: true });
}
// The extension's own NOTICE: costingly's copyright line from the repository's,
// then what this file actually bundles.
const notice = (await readFile(join(ROOT, "NOTICE"), "utf8")).split(/\n-{10,}/)[0]?.replace(/\n+This distribution bundles[^\n]*\n*$/, "").trimEnd() ?? "costingly";
await writeFile(
  join(STAGING, "NOTICE"),
  `${notice}\n\nThis extension bundles @modelcontextprotocol/sdk and its dependencies into ${BUNDLED};\n` +
    "their licence notices are preserved inside that file. It bundles no database engine\n" +
    "and no Plaid client: those belong to the Costingly desktop app.\n",
);
say("payload", SHIPPED.join(", "));

// One version, one place. `npm run set-version` keeps package.json and
// manifest.json together; this is the check that they stayed so.
const manifest = JSON.parse(await readFile(join(STAGING, "manifest.json"), "utf8")) as Record<string, unknown>;
if (manifest["version"] !== version) {
  say("version", `manifest ${String(manifest["version"])} -> ${version}`);
  manifest["version"] = version;
}
await writeFile(join(STAGING, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// --- 4. prove the bundled file starts and speaks the protocol --------------
// Run it the way Claude Desktop will: as a process on its own, with no
// node_modules, given an initialize request and a closed stdin. It has to
// answer with JSON-RPC and exit. Nothing of Costingly need be installed: an
// extension that cannot find the app still answers.
await selfCheck(join(STAGING, BUNDLED));
say("self-check", "answers initialize and exits");

// --- 5. the bundle holds what it should and nothing else -----------------
const staged = (await readdir(STAGING)).sort();
const expected = [BUNDLED, ...SHIPPED].sort();
if (JSON.stringify(staged) !== JSON.stringify(expected)) {
  throw new Error(`the staging folder holds ${staged.join(", ")}; expected exactly ${expected.join(", ")}`);
}
for (const name of staged) {
  const text = await readFile(join(STAGING, name), "utf8");
  if (/embedded-postgres|pg_ctl|initdb/.test(text)) throw new Error(`${name} names a database engine; the extension must not carry one`);
}
say("contents", "exactly the program file, the manifest and the licences; no database engine");

// --- 6. validate then pack ------------------------------------------------
// Validation first: a manifest error caught here is a build failure, and the
// same error caught by Claude Desktop is a silent install that does nothing.
await node(MCPB_CLI, ["validate", join(STAGING, "manifest.json")]);
say("validate", "manifest.json ok");

const packOutput = await node(MCPB_CLI, ["pack", STAGING, output]);
const files = /total files:\s*(\d+)/.exec(packOutput)?.[1] ?? "?";
const sha = /shasum:\s*(\S+)/.exec(packOutput)?.[1] ?? "?";
say("pack", `${files} files`);

const bytes = await sizeOf(output);
if (bytes > MAX_BUNDLE_BYTES) {
  throw new Error(`the extension is ${mb(bytes)}, over the ${mb(MAX_BUNDLE_BYTES)} limit; something that does not belong is inside it`);
}
console.log(`
  ${output}
  ${mb(bytes)}   sha1 ${sha}

  Install by opening the file with Claude Desktop.
`);

/**
 * Start the bundled file on its own, send an initialize request, close stdin,
 * and require a JSON-RPC answer on stdout, nothing else there, and a prompt
 * exit. Pointed at an empty profile so no real install is touched.
 */
async function selfCheck(file: string): Promise<void> {
  const home = join(BUILD, "self-check-profile");
  await rm(home, { recursive: true, force: true });
  const child = spawn(process.execPath, [file], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COSTINGLY_HOME: home, COSTINGLY_ADDRESS: "", COSTINGLY_TOKEN: "" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build-bundle", version: "0" } },
    })}\n`,
  );
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 20_000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    setTimeout(() => child.stdin.end(), 1_500);
  });
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const answered = lines.some((line) => {
    try {
      const parsed = JSON.parse(line) as { id?: unknown; result?: { serverInfo?: { name?: string } } };
      return parsed.id === 1 && parsed.result?.serverInfo?.name === "costingly";
    } catch {
      return false;
    }
  });
  if (!answered || lines.length !== 1 || code !== 0) {
    throw new Error(
      `the bundled extension did not behave: exit ${String(code)}, ${lines.length} stdout line(s), answered=${String(answered)}\n--- stderr ---\n${stderr}`,
    );
  }
}
