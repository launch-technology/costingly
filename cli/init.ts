/**
 * `costingly init` — interactive first-run setup.
 *
 * Replaces: copy .env.example, hand-edit it, run keygen, paste the key, invent
 * a CRON_SECRET, run migrate. That sequence is fine for the person who wrote it
 * and impossible for the `npx costingly` audience — on a clean machine there is
 * no project directory, so there is no .env to copy in the first place.
 *
 * Deliberately does NOT ask which Plaid environment to use. Sandbox is a test
 * fixture living in .env.sandbox, not a product feature; users are always on
 * production. See the Development section of the README.
 */

import type { Command } from "commander";
import { intro, outro, text, password, confirm, isCancel, cancel, log } from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { generateEncryptionKey } from "../src/crypto.js";
import { describeError } from "../src/plaid.js";
import { createLinkToken } from "../src/link.js";
import { dataDir } from "../src/db.js";
import { randomBytes } from "node:crypto";
import { packageRoot } from "./paths.js";
import { join } from "node:path";
import { loadedEnvPath, userConfigPath } from "./env.js";
import { readConfig, updateConfigFile } from "./config-file.js";
import { runMigrate } from "./migrate.js";
import { CliError } from "./errors.js";

interface InitOptions {
  /** Write to ~/.config/costingly/.env even when another config is active. */
  user?: boolean;
}

/**
 * Streams the prompts read and write.
 *
 * Same seam as pickAccounts/pickWindow in transactions.ts: defaults to the real
 * terminal, and lets tests drive the flow without a TTY. Clack's raw-mode
 * reader cannot be driven reliably through a pseudo-terminal, so this is the
 * only way to exercise init end to end.
 */
export interface PromptIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Set up credentials and create the database")
    .helpGroup("Setup — run once, in this order:")
    .option("--user", "write to ~/.config/costingly/.env, ignoring any local .env")
    .addHelpText(
      "after",
      `
Prompts for your Plaid credentials, verifies them against Plaid, generates an
encryption key, writes the config, and creates the database.

Safe to re-run: an existing encryption key is never replaced, because doing so
would make every stored access token permanently undecryptable.

Get credentials from https://dashboard.plaid.com/developers/keys`,
    )
    .action(async (options: InitOptions) => {
      await runInit(options);
    });
}

/** Where the config should be written. */
function targetPath(options: InitOptions): { path: string; updating: boolean } {
  if (options.user === true) return { path: userConfigPath(), updating: false };

  // Prefer the file already in effect. Writing anywhere else would produce a
  // config that a higher-precedence file silently shadows — the user would
  // change a value and see nothing happen.
  const active = loadedEnvPath();
  if (active !== null) return { path: active, updating: true };

  return { path: userConfigPath(), updating: false };
}

/**
 * Prove the credentials work before writing them.
 *
 * One round trip through /link/token/create, the same call `costingly link`
 * makes first. Catching a bad secret here beats surfacing it later as an
 * inscrutable failure halfway through linking a bank.
 */
async function verifyCredentials(clientId: string, secret: string): Promise<void> {
  process.env["PLAID_CLIENT_ID"] = clientId;
  process.env["PLAID_SECRET"] = secret;

  // getPlaidClient() memoises on globalThis, so a retry after a failed attempt
  // would otherwise reuse the client built from the previous credentials and
  // report the same error against the new ones.
  delete (globalThis as Record<string, unknown>)["__costinglyClient"];

  await createLinkToken();
}

export async function runInit(options: InitOptions, io: PromptIO = {}): Promise<void> {
  // A test supplying its own streams does not need a TTY.
  if (io.input === undefined && stdin.isTTY !== true) {
    throw new CliError(
      "costingly init is interactive and there is no terminal to prompt on.\n" +
        "Run it in a terminal, or write the config file yourself — see .env.example.",
    );
  }

  const { path, updating } = targetPath(options);
  const existing = await readConfig(path);

  intro("costingly setup", io);

  if (updating) {
    log.info(`Updating ${path}`, io);
  } else {
    log.info(`Will write ${path}`, io);
  }

  // --- credentials --------------------------------------------------------
  const clientId = await text({
    ...io,
    message: "Plaid client_id",
    placeholder: existing["PLAID_CLIENT_ID"] ? "(press enter to keep the current one)" : "",
    validate: (value) => {
      const supplied = value?.trim() ?? "";
      if (supplied === "" && existing["PLAID_CLIENT_ID"]) return undefined;
      if (supplied === "") return "Required. Find it at dashboard.plaid.com/developers/keys";
      return undefined;
    },
  });
  if (isCancel(clientId)) return cancelled(io);

  const resolvedClientId =
    clientId.trim() === "" ? (existing["PLAID_CLIENT_ID"] ?? "") : clientId.trim();

  // `password` has no placeholder or default, so "keep the existing one" is
  // conveyed in the message and implemented as "empty means keep".
  const secret = await password({
    ...io,
    message: existing["PLAID_SECRET"]
      ? "Plaid secret (enter to keep the current one)"
      : "Plaid secret",
    validate: (value) => {
      const supplied = value?.trim() ?? "";
      if (supplied === "" && existing["PLAID_SECRET"]) return undefined;
      if (supplied === "") return "Required.";
      return undefined;
    },
  });
  if (isCancel(secret)) return cancelled(io);

  const resolvedSecret = secret.trim() === "" ? (existing["PLAID_SECRET"] ?? "") : secret.trim();

  // --- verify before writing anything -------------------------------------
  try {
    await verifyCredentials(resolvedClientId, resolvedSecret);
    log.success("Plaid accepted the credentials", io);
  } catch (error) {
    // describeError strips the axios object, which carries the PLAID-SECRET
    // header. Never render the raw error here.
    cancel(`Plaid rejected the credentials:\n  ${describeError(error)}\n\nNothing was written.`, io);
    process.exitCode = 1;
    return;
  }

  // --- secrets ------------------------------------------------------------
  const updates: Record<string, string> = {
    PLAID_CLIENT_ID: resolvedClientId,
    PLAID_SECRET: resolvedSecret,
  };

  if (existing["ENCRYPTION_KEY"]) {
    // Never regenerated. Replacing it would make every stored access token
    // permanently undecryptable, and no setup command should be able to do
    // that by accident. Rotation is a deliberate, separate act.
    log.info("Keeping the existing encryption key", io);
  } else {
    updates["ENCRYPTION_KEY"] = generateEncryptionKey();
    log.success("Generated an encryption key", io);
  }

  if (!existing["CRON_SECRET"]) {
    updates["CRON_SECRET"] = randomBytes(32).toString("base64");
  }

  // --- write --------------------------------------------------------------
  const template = await readFile(join(packageRoot, ".env.example"), "utf8");
  await updateConfigFile(path, updates, template);
  log.success(`Wrote ${path}`, io);

  if (updates["ENCRYPTION_KEY"]) {
    log.warn(
      "Back up your encryption key. Losing it means re-linking every bank:\n" +
        `  grep ENCRYPTION_KEY ${path}`,
    );
  }

  // --- database -----------------------------------------------------------
  const proceed = await confirm({
    ...io,
    message: `Create the database at ${dataDir()}?`,
    initialValue: true,
  });
  if (isCancel(proceed)) return cancelled(io);

  if (proceed) {
    await runMigrate();
    log.success("Database ready", io);
  }

  outro("Next:  costingly link", io);
}

function cancelled(io: PromptIO): void {
  cancel("Cancelled. Nothing was written.", io);
}
