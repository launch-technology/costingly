/**
 * Where this package's non-code files live.
 *
 * Nothing here may assume a fixed depth. The same module runs from `cli/` under
 * tsx and from `<pkg>/dist/cli/` once compiled and installed. Walking up to the
 * nearest package.json is correct in every layout:
 *
 *   dev      <repo>/cli/paths.ts                                  -> <repo>
 *   built    <repo>/dist/cli/paths.js                             -> <repo>
 *   linked   <prefix>/lib/node_modules/<pkg>/dist/apps/cli/...  -> the package
 *
 * `dirname(import.meta.url) + ".."` — what migrate/link/help used to do — is
 * right in dev and off by one everywhere else. It failed silently in help.ts,
 * which just hit its catch and quietly disabled its own drift check.
 *
 * Deliberately in cli/, not src/: src/ must stay copy-pasteable into a Next.js
 * repo, where bundling makes import.meta.url meaningless.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);

  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === root) {
      throw new Error(
        "Could not locate the package root (no package.json above " +
          `${fileURLToPath(import.meta.url)}).`,
      );
    }
    dir = dirname(dir);
  }
}

/** Root of the installed package — the directory holding package.json. */
export const packageRoot = findPackageRoot();

/** Directory of numbered .sql migrations, applied in filename order. */
export const migrationsDir = join(packageRoot, "migrations");
export const publicDir = join(packageRoot, "public");

/** Version from package.json, for `--version`. Never throws. */
export function packageVersion(): string {
  try {
    const raw = readFileSync(join(packageRoot, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
