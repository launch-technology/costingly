/**
 * Reading and writing the `.env`-style config file.
 *
 * The first code in this project that writes a config file — everything before
 * it assumed the user had hand-edited one. Two rules shape it:
 *
 *   Updating never destroys. Unknown keys, comments and ordering all survive,
 *   because this file may hold things we do not know about and definitely holds
 *   the user's own notes.
 *
 *   Writing is atomic and private. Temp file, chmod, rename — mirroring the
 *   usual temp-file idiom. A half-written config containing a live PLAID_SECRET
 *   is not an acceptable intermediate state.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Owner read/write only. These files hold live credentials. */
const CONFIG_MODE = 0o600;

export type ConfigValues = Record<string, string>;

/**
 * Parse an env file into a plain map.
 *
 * Intentionally minimal: `KEY=value`, ignoring blanks, `#` comments and
 * `export ` prefixes, stripping one layer of matching quotes. dotenv does the
 * real parsing at load time; this only needs to be good enough to answer "does
 * this key already have a value?" before deciding whether to generate one.
 */
export function parseEnv(contents: string): ConfigValues {
  const values: ConfigValues = {};

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

/** Read and parse a config file. Returns an empty map when it does not exist. */
export async function readConfig(path: string): Promise<ConfigValues> {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Apply updates to an existing file's text, in place.
 *
 * A key that is already present — even commented out — is rewritten where it
 * sits, so the explanatory comment above it stays attached to the right thing.
 * Keys that are genuinely new are appended. Everything else is untouched.
 */
export function applyUpdates(contents: string, updates: ConfigValues): string {
  const lines = contents.split("\n");
  const remaining = new Set(Object.keys(updates));

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    // Match `KEY=`, `export KEY=`, and the commented `# KEY=` form that
    // .env.example uses for optional settings.
    const match = /^(\s*)(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;

    const [, indent = "", key = ""] = match;
    if (!remaining.has(key)) return line;

    // A commented example line only gets claimed if we are actually setting it;
    // otherwise `# PORT=4000` would be silently uncommented.
    remaining.delete(key);
    void trimmed;
    return `${indent}${key}=${updates[key] ?? ""}`;
  });

  const appended: string[] = [];
  for (const key of remaining) {
    appended.push(`${key}=${updates[key] ?? ""}`);
  }

  if (appended.length > 0) {
    // Keep exactly one blank line before anything we add.
    while (rewritten.length > 0 && rewritten[rewritten.length - 1]!.trim() === "") {
      rewritten.pop();
    }
    rewritten.push("", ...appended, "");
  }

  return rewritten.join("\n");
}

/**
 * Write `contents` to `path` atomically, owner-only.
 *
 * chmod happens on the temp file *before* the rename, so the config is never
 * momentarily world-readable at its final path.
 */
export async function writeConfigFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const temp = join(dirname(path), `.${process.pid}.tmp`);
  try {
    await writeFile(temp, contents, { mode: CONFIG_MODE });
    await chmod(temp, CONFIG_MODE);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Write updates to `path`, preserving whatever is already there.
 *
 * When the file does not exist, `template` seeds it — the shipped
 * `.env.example`, so a generated config keeps its explanatory comments.
 */
export async function updateConfigFile(
  path: string,
  updates: ConfigValues,
  template: string,
): Promise<void> {
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = template;
  }
  await writeConfigFile(path, applyUpdates(existing, updates));
}
