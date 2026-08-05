/**
 * Environment configuration.
 *
 * Deliberately framework-agnostic: this module reads `process.env` and nothing
 * else. It does NOT load a .env file — the local CLI entrypoints in `scripts/`
 * do that via `dotenv/config`, and on Vercel the env vars are already present.
 * That keeps `src/` importable unchanged from a Next.js route handler.
 *
 * Every value is exposed as a lazy getter so that merely importing this module
 * never throws. A missing variable only fails when something actually needs it,
 * which means `plaid-sync keygen` works before .env is filled in.
 */

export type PlaidEnvName = "sandbox" | "production";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function plaidEnvName(): PlaidEnvName {
  const raw = (process.env["PLAID_ENV"] ?? "production").trim().toLowerCase();
  if (raw === "sandbox" || raw === "production") {
    return raw;
  }
  throw new Error(
    `Invalid PLAID_ENV: "${raw}". Must be "sandbox" or "production". ` +
      `(Plaid retired the "development" environment; use sandbox for testing.)`,
  );
}

export const config = {
  get plaidClientId(): string {
    return required("PLAID_CLIENT_ID");
  },
  get plaidSecret(): string {
    return required("PLAID_SECRET");
  },
  get plaidEnv(): PlaidEnvName {
    return plaidEnvName();
  },
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  get encryptionKey(): string {
    return required("ENCRYPTION_KEY");
  },
  get cronSecret(): string {
    return required("CRON_SECRET");
  },
  /** Port for the local Plaid Link server. Not used in serverless. */
  get port(): number {
    const raw = process.env["PORT"];
    if (raw === undefined || raw.trim() === "") return 4000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`Invalid PORT: "${raw}"`);
    }
    return parsed;
  },
};
