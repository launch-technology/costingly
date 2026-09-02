/**
 * The layering rules, enforced.
 *
 * Costingly is three layers — `platform` (no costingly knowledge), `domain`
 * (costingly's logic) and `apps` (one folder per interface) — and dependencies
 * point down only. Two mechanisms hold that true: the compiler, via the
 * composite tsconfigs in `npm run typecheck`, and this suite, for the rules
 * types cannot express.
 *
 * WHY THIS IS A REGEX AND NOT AN AST WALK
 *
 * Because a check people avoid touching stops being a check. Every rule below
 * is decidable from the import line alone, and a suite that is obvious to read
 * gets updated when the rules change instead of being deleted when it breaks.
 *
 * WHY THE LAYER MAP IS DATA
 *
 * `LAYERS` names where each root folder sits, so a future move updates that
 * table rather than this logic.
 *
 * See ARCHITECTURE.md for what the layers mean and why.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, posix, relative } from "node:path";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const out: string[] = [];
let fail = 0;

function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    out.push(`  ok    ${what}`);
  } else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

/** No offenders is the only passing state, and the names are the error message. */
function none(offenders: string[], what: string): void {
  eq(offenders.sort(), [], what);
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

type Layer = "platform" | "domain" | "app" | "barrel";

/**
 * Which layer each root path belongs to.
 *
 * Longest prefix wins, so a nested entry can override its parent. Updated by
 * each migration phase; the assertions below never are.
 */
const LAYERS: ReadonlyArray<readonly [prefix: string, layer: Layer]> = [
  ["apps/", "app"],
  ["domain/", "domain"],
  ["platform/", "platform"],
  ["index.ts", "barrel"],
];

/** The only root folders. A fourth is a decision, not an accident. */
const ROOT_FOLDERS = ["apps", "domain", "platform"];

/** What each layer may import. A layer may always import its own. */
const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  app: ["app", "domain", "platform", "barrel"],
  domain: ["domain", "platform"],
  platform: ["platform"],
  barrel: ["app", "domain", "platform", "barrel"],
};

/** Which interface a file belongs to. Every folder under apps/ is one. */
function appOf(path: string): string | null {
  const match = /^apps\/([^/]+)\//.exec(path);
  return match?.[1] ?? null;
}

function layerOf(path: string): Layer | null {
  let best: readonly [string, Layer] | undefined;
  for (const entry of LAYERS) {
    if (path.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) {
      best = entry;
    }
  }
  return best?.[1] ?? null;
}

interface SourceFile {
  /** Posix path relative to src/, e.g. "apps/cli/main.ts". */
  path: string;
  layer: Layer | null;
  text: string;
  /** Every import specifier, in source order. */
  imports: string[];
}

/** Every `from "..."` and `import("...")` specifier in a file. */
function importsIn(text: string): string[] {
  const found: string[] = [];
  // Covers `from "x"`, `import "x"` and dynamic `import("x")`. Deliberately
  // ignores whether the import is type-only: a type-only import still names a
  // dependency, and a layer that may not know a module may not know its types.
  const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

async function collect(dir: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(full)));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;

    const path = relative(SRC, full).split("\\").join("/");
    const text = await readFile(full, "utf8");
    files.push({ path, layer: layerOf(path), text, imports: importsIn(text) });
  }
  return files;
}

const files = await collect(SRC);

/** A relative specifier resolved back to a src-relative path, or null. */
function targetOf(file: SourceFile, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const from = posix.dirname(file.path);
  return posix.normalize(posix.join(from, specifier)).replace(/\.js$/, ".ts");
}

// ---------------------------------------------------------------------------

out.push(`  --    ${files.length} source files under src/`);
ok(files.length > 50, "the tree was actually scanned");

// --- every file has a layer -------------------------------------------------
// The rule that stops the next src/plaid/ appearing. A new root folder is a
// deliberate act; adding one means deciding which layer it is in, here.
none(
  files.filter((f) => f.layer === null).map((f) => f.path),
  "every file under src/ belongs to a declared layer",
);

// --- dependencies point down only -------------------------------------------
const upward: string[] = [];
for (const file of files) {
  if (file.layer === null) continue;
  const allowed = MAY_IMPORT[file.layer];
  for (const specifier of file.imports) {
    const target = targetOf(file, specifier);
    if (target === null) continue;
    const targetLayer = layerOf(target);
    if (targetLayer === null || allowed.includes(targetLayer)) continue;
    upward.push(`${file.path} (${file.layer}) -> ${target} (${targetLayer})`);
  }
}
none(upward, "dependencies point down only: apps -> domain -> platform");

// --- the root folders are the layers ----------------------------------------
// The rule that stops the next src/plaid/ appearing. A new root folder means
// deciding which layer it is, here, before any code lands in it.
none(
  files
    .map((f) => f.path.split("/")[0] ?? "")
    .filter((root) => root.endsWith(".ts") === false && !ROOT_FOLDERS.includes(root))
    .filter((root, i, all) => all.indexOf(root) === i),
  `src/ has exactly these root folders: ${ROOT_FOLDERS.join(", ")}`,
);

// --- the interfaces never import each other ---------------------------------
const crossApp: string[] = [];
for (const file of files) {
  const mine = appOf(file.path);
  if (mine === null) continue;
  for (const specifier of file.imports) {
    const target = targetOf(file, specifier);
    if (target === null) continue;
    const theirs = appOf(target);
    if (theirs !== null && theirs !== mine) crossApp.push(`${file.path} -> ${target}`);
  }
}
none(crossApp, "no interface imports another interface");

// --- one interface's UX stays in that interface -----------------------------
//
// The question is not "does this present something" but "to WHOSE interface".
// commander and clack render the terminal experience and mean nothing to a
// model, so they belong to the CLI.
//
// express is deliberately NOT on this list. It serves the Plaid Link page,
// which both interfaces need because Plaid requires a browser round trip — and
// a rule that forced presentation into apps/ would mean writing that page
// twice. Shared presentation is a service; per-interface presentation is not.
const UI_PACKAGES = ["commander", "@clack/prompts"];
none(
  files
    .filter((f) => f.layer !== "app" && f.layer !== "barrel")
    .filter((f) => f.imports.some((i) => UI_PACKAGES.includes(i)))
    .map((f) => f.path),
  `no ${UI_PACKAGES.join(" / ")} outside the app layer`,
);

// --- pg has exactly one home ------------------------------------------------
// Everything else asks for an Executor. When this moves to platform/postgres/
// in phase 1, only the prefix below changes.
const PG_HOME = "platform/postgres/";
none(
  files
    .filter((f) => !f.path.startsWith(PG_HOME))
    .filter((f) => f.imports.includes("pg"))
    .map((f) => f.path),
  `only ${PG_HOME} imports pg directly`,
);

// --- repositories take an executor, never reach for one ---------------------
// The property that makes it impossible for a repository statement to escape
// the transaction its siblings are in.
none(
  files
    .filter((f) => f.path.includes("/repositories/"))
    .filter((f) => f.imports.some((i) => i.includes("default-database")))
    .map((f) => f.path),
  "no repository imports a DataSource — they are handed an Executor",
);

// --- plaid is reached through one client ------------------------------------
// Enums and types from `plaid` are fair game anywhere in the domain — they are
// vocabulary. What must not spread is the CLIENT: two constructions mean two
// places deciding which environment and which credentials are in play.
const PLAID_HOME = "domain/data/plaid.client.ts";
const CLIENT_SYMBOLS = ["PlaidApi", "Configuration", "PlaidEnvironments"];
none(
  files
    .filter((f) => f.path !== PLAID_HOME)
    .filter((f) =>
      [...f.text.matchAll(/imports+(?!type){([^}]*)}s*froms*"plaid"/g)].some((m) =>
        CLIENT_SYMBOLS.some((s) => (m[1] ?? "").includes(s)),
      ),
    )
    .map((f) => f.path),
  `only ${PLAID_HOME} constructs a Plaid client`,
);

// --- composition happens in a constructor, not a module setter ---------------
// Both of these registered a function that lived one import away, and both
// carried a runtime guard against being called too late. The names are a
// tripwire: the pattern is what is banned, not the two functions.
none(
  files
    .filter((f) => /set(MigrationSource|PublicDir)/.test(f.text))
    .map((f) => f.path),
  "no module-level registration setters",
);

// ---------------------------------------------------------------------------
// No interface writes through a repository
// ---------------------------------------------------------------------------
//
// Reads for display may live in a command or a tool — a `status` listing is not
// a use case, and routing it through a service would add a file that only
// forwards. WRITES are different: a change to the data is a use case, it has
// invariants, and both interfaces must get the same one. The MCP unlink tool
// used to assemble its own revoke-then-delete beside the service that already
// did it, which is exactly how the two drift apart.
const WRITES = [
  "saveItem",
  "setItemCursor",
  "setItemStatus",
  "deleteItem",
  "deleteAll",
  "deleteBySource",
  "clearCursors",
  "upsertMany",
  "deleteByIds",
];

const appWrites: string[] = [];
for (const file of files.filter((f) => f.layer === "app")) {
  for (const match of file.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]*repositor[^"]*)"/g)) {
    const named = (match[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]?.trim());
    for (const symbol of named) {
      if (symbol !== undefined && WRITES.includes(symbol)) {
        appWrites.push(`${file.path} imports ${symbol}`);
      }
    }
  }
}
none(appWrites, "no interface writes through a repository — writes go via a service");

// --- platform names no project ----------------------------------------------
//
// The whole point of the layer. platform/ is handed a ProjectIdentity and
// resolves paths, a database name and an environment variable from it — so the
// word "costingly" appearing anywhere under it, in code OR in a comment, means
// something has been assumed rather than supplied.
//
// This is what makes extracting platform/ a folder move rather than a rewrite.
none(
  files
    .filter((f) => f.layer === "platform")
    .filter((f) => /costingly/i.test(f.text))
    .map((f) => f.path),
  "platform/ never names a project",
);

// --- the barrel is for consumers of the package, not for src ----------------
// src/index.ts declares what costingly exposes if it is ever imported as a
// library, and the suites use it as a convenient façade. Nothing inside src/
// should reach for it: a module that imports the barrel imports every layer.
none(
  files
    .filter((f) => f.layer !== "barrel")
    .filter((f) => f.imports.some((i) => /(^|\/)index\.js$/.test(i)))
    .map((f) => f.path),
  "nothing under src/ imports the barrel",
);

// ---------------------------------------------------------------------------

console.log(out.join("\n"));
console.log(
  fail === 0
    ? `\nAll ${out.filter((l) => l.startsWith("  ok") || l.startsWith("  FAIL")).length} checks passed.`
    : `\n${fail} FAILED.`,
);
process.exit(fail === 0 ? 0 : 1);
