/**
 * `costingly keygen` — print a fresh ENCRYPTION_KEY.
 *
 * The key goes to stdout and the guidance to stderr, so it can be piped:
 *   costingly keygen >> .env
 */

import type { Command } from "commander";
import { generateEncryptionKey } from "../src/crypto.js";

export function registerKeygenCommand(program: Command): void {
  program
    .command("keygen")
    .description("Print a fresh ENCRYPTION_KEY for .env")
    .helpGroup("Setup — run once, in this order:")
    .addHelpText(
      "after",
      `
The key goes to stdout and the explanation to stderr, so this works:
  costingly keygen >> .env`,
    )
    .action(() => {
      runKeygen();
    });
}

export function runKeygen(): void {
  const key = generateEncryptionKey();

  console.error("Add this to your .env file:\n");
  console.log(`ENCRYPTION_KEY=${key}`);
  console.error(
    "\nThis key encrypts your Plaid access tokens at rest (AES-256-GCM).\n" +
      "Back it up somewhere safe. If you lose it, the stored tokens cannot be\n" +
      "decrypted and you will have to re-link every bank.\n",
  );
}
