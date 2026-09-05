/**
 * Confirmation gate for destructive commands.
 *
 * The design goal is that you cannot destroy production data by muscle memory.
 * So it does three things:
 *
 *   1. States which profile and which database are being targeted, loudly.
 *      "I thought I was pointed at the sandbox" is the failure mode this exists
 *      to prevent.
 *   2. Shows what will actually be destroyed, counted from the database.
 *   3. Requires typing the profile's name — not "y". A confirmation you can
 *      satisfy with a reflex is not a confirmation.
 *
 * WHY THE PROFILE AND NOT THE PLAID ENVIRONMENT
 *
 * The phrase used to be `plaidEnv`, which was the wrong thing to guard twice
 * over. It named a concept costingly does not have — costingly has profiles,
 * not environments — and it did not discriminate: nearly every install is
 * "production", so every user typed the same word and muscle memory carried
 * straight across profiles. The profile IS the blast radius, so it is what the
 * user is asked to name. The Plaid environment is still shown, because which
 * one you are pointed at is worth knowing before you destroy anything.
 */

import { text, isCancel, cancel } from "@clack/prompts";
import { stdin } from "node:process";
import { get } from "../../../domain/config.js";
import { server } from "../../../domain/project.js";
import { platform } from "../../../domain/project.js";

/**
 * Which database is about to be modified.
 *
 * Naming the profile is the point: with more than one on a machine — a sandbox,
 * a checkout, the real one — "which database am I about to empty?" is the
 * question this gate exists to answer.
 */
export function describeDatabase(): string {
  return `${platform.displayPath(server.dataDir())}  (on this machine)`;
}

export interface ConfirmOptions {
  /** Headline, e.g. "Delete ALL local data". */
  action: string;
  /** Label/value pairs shown above the prompt. */
  facts: Array<[string, string]>;
  /** Bullet points spelling out the consequences. */
  consequences: string[];
  /** Set by --yes: skip the prompt entirely. */
  skipPrompt: boolean;
}

/**
 * Returns true if the caller should proceed.
 *
 * A non-interactive shell can neither read the warning nor answer it, so it
 * refuses unless --yes was passed explicitly.
 */
export async function confirmDestructive(options: ConfirmOptions): Promise<boolean> {
  const profile = platform.profileName();
  const width = Math.max(...options.facts.map(([label]) => label.length), "Plaid".length);

  console.log("");
  console.log(`  ⚠  ${options.action.toUpperCase()}`);
  console.log("");
  console.log(`     ${"Profile".padEnd(width)}   ${profile}`);
  console.log(`     ${"Database".padEnd(width)}   ${describeDatabase()}`);
  console.log(`     ${"Plaid".padEnd(width)}   ${get("plaidEnv").toUpperCase()}`);
  for (const [label, value] of options.facts) {
    console.log(`     ${label.padEnd(width)}   ${value}`);
  }
  console.log("");
  for (const line of options.consequences) {
    console.log(`     • ${line}`);
  }
  console.log("");

  if (options.skipPrompt) {
    console.log("  --yes given; proceeding without confirmation.\n");
    return true;
  }

  if (stdin.isTTY !== true) {
    console.error(
      "  Refusing to run: this is destructive and there is no terminal to confirm on.\n" +
        "  Re-run interactively, or pass --yes if you are certain.\n",
    );
    process.exitCode = 1;
    return false;
  }

  // Typing the profile's name means a wipe of the real profile cannot be
  // confirmed with the same keystrokes as a wipe of a throwaway one.
  const answer = await text({
    message: `Type "${profile}" to confirm:`,
    placeholder: profile,
    validate: (value) =>
      value === profile ? undefined : `Type exactly "${profile}", or press Ctrl-C to abort.`,
  });

  if (isCancel(answer)) {
    cancel("Aborted. Nothing was deleted.");
    return false;
  }
  return true;
}
