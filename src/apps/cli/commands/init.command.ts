/**
 * `costingly init` — interactive first-run setup.
 *
 * Prompts for Plaid credentials, proves they work, generates an encryption key,
 * writes `config.json` into the profile, and creates the database.
 *
 * The config file is written by this command, not hand-edited by the user —
 * which is the whole reason it can be JSON and the reason `costingly config`
 * can rewrite it later without mangling anything.
 *
 * Deliberately does NOT ask which Plaid environment to use. Sandbox is a test
 * fixture — a separate profile with `plaidEnv: "sandbox"` in it — not a product
 * feature. Users are always on production.
 */

import type { Command } from "commander";
import { intro, outro, text, password, confirm, isCancel, cancel, log } from "@clack/prompts";
import { stdin } from "node:process";
import { generateEncryptionKey } from "../../../domain/crypto.js";
import { describeError } from "../../../domain/data/plaid.client.js";
import { createLinkToken } from "../../../domain/services/banks/link.service.js";
import { clusterDir } from "../../../platform/postgres/server.js";
import { configPath, displayPath, profileDir, profileSource } from "../../../platform/profile.js";
import { readConfigFile, writeConfig, type StoredConfig } from "../../../domain/config.js";
import { runMigrate } from "./migrate.command.js";
import { CliError } from "../errors.js";

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
    .addHelpText(
      "after",
      `
Prompts for your Plaid credentials, verifies them against Plaid, generates an
encryption key, writes the config, and creates the database.

Safe to re-run: an existing encryption key is never replaced, because doing so
would make every stored access token permanently undecryptable.

Everything is written into one profile directory. Set COSTINGLY_HOME to use a
different one — a checkout, or a sandbox for testing.

Get credentials from https://dashboard.plaid.com/developers/keys`,
    )
    .action(async () => {
      await runInit();
    });
}

/**
 * Prove the credentials work before writing them.
 *
 * One round trip through /link/token/create, the same call `costingly link`
 * makes first. Catching a bad secret here beats surfacing it later as an
 * inscrutable failure halfway through linking a bank.
 */
async function verifyCredentials(clientId: string, secret: string): Promise<void> {
  // The config layer reads the environment before the file, so setting these
  // makes the Plaid client pick them up without anything being written to disk.
  process.env["PLAID_CLIENT_ID"] = clientId;
  process.env["PLAID_SECRET"] = secret;

  // getPlaidClient() memoises on globalThis, so a retry after a failed attempt
  // would otherwise reuse the client built from the previous credentials and
  // report the same error against the new ones.
  delete (globalThis as Record<string, unknown>)["__costinglyClient"];

  await createLinkToken();
}

export async function runInit(io: PromptIO = {}): Promise<void> {
  // A test supplying its own streams does not need a TTY.
  if (io.input === undefined && stdin.isTTY !== true) {
    throw new CliError(
      "costingly init is interactive and there is no terminal to prompt on.\n" +
        "Run it in a terminal, or set PLAID_CLIENT_ID, PLAID_SECRET and\n" +
        "ENCRYPTION_KEY in the environment instead.",
    );
  }

  const path = configPath();
  const existing = readConfigFile();
  const updating = Object.keys(existing).length > 0;

  intro("costingly setup", io);

  log.info(
    `${updating ? "Updating" : "Will write"} ${displayPath(path)}\n` +
      `Profile: ${displayPath(profileDir())}  (${profileSource()})`,
    io,
  );

  // --- credentials --------------------------------------------------------
  const clientId = await text({
    ...io,
    message: "Plaid client_id",
    placeholder: existing.plaidClientId ? "(press enter to keep the current one)" : "",
    validate: (value) => {
      const supplied = value?.trim() ?? "";
      if (supplied === "" && existing.plaidClientId) return undefined;
      if (supplied === "") return "Required. Find it at dashboard.plaid.com/developers/keys";
      return undefined;
    },
  });
  if (isCancel(clientId)) return cancelled(io);

  const resolvedClientId =
    clientId.trim() === "" ? (existing.plaidClientId ?? "") : clientId.trim();

  // `password` has no placeholder or default, so "keep the existing one" is
  // conveyed in the message and implemented as "empty means keep".
  const secret = await password({
    ...io,
    message: existing.plaidSecret ? "Plaid secret (enter to keep the current one)" : "Plaid secret",
    validate: (value) => {
      const supplied = value?.trim() ?? "";
      if (supplied === "" && existing.plaidSecret) return undefined;
      if (supplied === "") return "Required.";
      return undefined;
    },
  });
  if (isCancel(secret)) return cancelled(io);

  const resolvedSecret = secret.trim() === "" ? (existing.plaidSecret ?? "") : secret.trim();

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

  // --- the encryption key -------------------------------------------------
  let encryptionKey = existing.encryptionKey;
  if (encryptionKey) {
    // Never regenerated. Replacing it would make every stored access token
    // permanently undecryptable, and no setup command should be able to do that
    // by accident. Rotation is a deliberate, separate act.
    log.info("Keeping the existing encryption key", io);
  } else {
    encryptionKey = generateEncryptionKey();
    log.success("Generated an encryption key", io);
  }

  // --- write --------------------------------------------------------------
  const values: StoredConfig = {
    plaidClientId: resolvedClientId,
    plaidSecret: resolvedSecret,
    encryptionKey,
    plaidEnv: existing.plaidEnv ?? "production",
  };
  await writeConfig(values);
  log.success(`Wrote ${displayPath(path)}`, io);

  if (!existing.encryptionKey) {
    log.warn(
      "Back up your encryption key. Losing it means re-linking every bank:\n" +
        `  ${displayPath(path)}`,
      io,
    );
  }

  // --- database -----------------------------------------------------------
  const proceed = await confirm({
    ...io,
    message: `Create the database at ${displayPath(clusterDir())}?`,
    initialValue: true,
  });
  if (isCancel(proceed)) return cancelled(io);

  if (proceed) {
    // First run does real work here — initdb, start the postmaster, CREATE
    // DATABASE — all triggered lazily through the driver. Worth saying so,
    // because initdb takes a few seconds and silence reads as a hang.
    log.info("Setting up PostgreSQL (first run takes a few seconds)…", io);
    await runMigrate();
    log.success("Database ready", io);
  }

  outro("Next:  costingly link", io);
}

function cancelled(io: PromptIO): void {
  cancel("Cancelled. Nothing was written.", io);
}
