/**
 * Bump the version:  npm run set-version <major|minor|patch>
 *
 * The version lives in four places because three different things read it:
 * package.json is what `costingly --version` prints and what the MCP server
 * reports in its handshake, manifest.json is what Claude Desktop shows in its
 * extension list, and package-lock.json records it twice. Bumping one and
 * forgetting another ships a build that is confidently wrong about what it is.
 *
 * Deliberately NOT `npm version`, which commits and tags as well as editing
 * files. This only edits files. Committing and tagging are done by hand.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const RELEASES = ["major", "minor", "patch"] as const;
type Release = (typeof RELEASES)[number];

const release = process.argv[2];

if (release === undefined || !RELEASES.includes(release as Release)) {
  console.error(`\nUsage: npm run set-version <${RELEASES.join("|")}>\n`);
  process.exit(1);
}

function next(current: string, kind: Release): string {
  const parts = current.split(".").map(Number);

  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    console.error(`\npackage.json version is "${current}", which is not major.minor.patch.\n`);
    process.exit(1);
  }

  const [major, minor, patch] = parts as [number, number, number];

  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Rewrite one JSON file, preserving the two-space shape it is already in. */
async function edit(file: string, change: (json: Record<string, unknown>) => void): Promise<void> {
  const path = join(ROOT, file);
  const json = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(json);
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  ${file}`);
}

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
const from = pkg.version;
const to = next(from, release as Release);

console.log(`\n${from} -> ${to}\n`);

await edit("package.json", (json) => {
  json["version"] = to;
});

await edit("manifest.json", (json) => {
  json["version"] = to;
});

await edit("package-lock.json", (json) => {
  json["version"] = to;
  // The lockfile names the package's own version twice: once at the root and
  // once in the entry for the root package itself. npm reads the second.
  const packages = json["packages"] as Record<string, { version?: string }> | undefined;
  const root = packages?.[""];
  if (root !== undefined) root.version = to;
});

console.log(`\nNothing was committed or tagged.\n`);
