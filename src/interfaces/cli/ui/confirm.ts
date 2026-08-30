/**
 * Confirmation gate for destructive commands.
 *
 * The design goal is that you cannot destroy production data by muscle memory.
 * So it does three things:
 *
 *   1. States the environment and the exact database being targeted, loudly.
 *      "I thought I was pointed at the docker container" is the failure mode
 *      this exists to prevent.
 *   2. Shows what will actually be destroyed, counted from the database.
 *   3. Requires typing the environment name — not "y". A confirmation you can
 *      satisfy with a reflex is not a confirmation.
 */

import { text, isCancel, cancel } from "@clack/prompts";
import { stdin } from "node:process";
import { get } from "../../../core/config.js";
import { clusterDir } from "../../../data/db/server.js";
import { displayPath } from "../../../core/profile.js";

/**
 * Which database is about to be modified.
 *
 * Naming the profile is the point: with more than one on a machine — a sandbox,
 * a checkout, the real one — "which database am I about to empty?" is the
 * question this gate exists to answer.
 */
export function describeDatabase(): string {
  return `${displayPath(clusterDir())}  (on this machine)`;
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
  const environment = get("plaidEnv").toUpperCase();
  const width = Math.max(...options.facts.map(([label]) => label.length), "Environment".length);

  console.log("");
  console.log(`  ⚠  ${options.action.toUpperCase()}`);
  console.log("");
  console.log(`     ${"Environment".padEnd(width)}   ${environment}`);
  console.log(`     ${"Database".padEnd(width)}   ${describeDatabase()}`);
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

  // Typing the environment name means a production wipe cannot be confirmed
  // with the same keystrokes as a sandbox one.
  const phrase = get("plaidEnv");
  const answer = await text({
    message: `Type "${phrase}" to confirm:`,
    placeholder: phrase,
    validate: (value) =>
      value === phrase ? undefined : `Type exactly "${phrase}", or press Ctrl-C to abort.`,
  });

  if (isCancel(answer)) {
    cancel("Aborted. Nothing was deleted.");
    return false;
  }
  return true;
}
