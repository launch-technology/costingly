/**
 * The environment banner shown above `plaid-sync --help`.
 *
 * Lifted from the old hand-rolled help.ts. Reads `process.env` directly rather
 * than src/config.ts, because config throws on invalid values and help must
 * still render when the configuration is broken — that is precisely when you
 * are reaching for it.
 */

import { loadedEnvPath } from "./env.js";

export function environmentBanner(): string {
  const lines: string[] = [];

  const rawEnv = (process.env["PLAID_ENV"] ?? "production").trim().toLowerCase();
  const known = rawEnv === "sandbox" || rawEnv === "production";
  lines.push(
    `  Plaid environment   ${rawEnv.toUpperCase()}` +
      (known ? "" : "   (invalid — expected sandbox or production)"),
  );

  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.trim() === "") {
    lines.push("  Database            (DATABASE_URL not set — copy .env.example to .env)");
  } else {
    try {
      const parsed = new URL(url);
      const database = parsed.pathname.replace(/^\//, "") || "(default)";
      const port = parsed.port ? `:${parsed.port}` : "";
      const local =
        parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
          ? "   (local docker)"
          : "";
      lines.push(`  Database            ${database} @ ${parsed.hostname}${port}${local}`);
    } catch {
      lines.push("  Database            (unparseable DATABASE_URL)");
    }
  }

  const envPath = loadedEnvPath();
  lines.push(
    envPath === null
      ? "  Config file         (none found — copy .env.example to .env)"
      : `  Config file         ${envPath}`,
  );

  return `\n${lines.join("\n")}\n`;
}
