/**
 * `costingly seed` — fill this profile with fabricated bank data.
 *
 *   costingly seed                       two years, ending today
 *   costingly seed --years 5             a longer history
 *   costingly seed --end-date 2026-08-09 pin the last day, for a repeatable take
 *   costingly seed --seed 7              a different but equally deterministic set
 *
 * DELIBERATELY NOT AN MCP TOOL
 *
 * This writes transactions. Exposing it to the model would mean a tool that
 * fabricates financial records, reachable from a conversation, in a database
 * whose transaction descriptions are attacker-influenced text. The rest of
 * costingly gives the model a read-only role and no way around it; this would
 * be the hole in that. Anyone who needs seeded data has a terminal.
 */

import type { Command } from "commander";
import { generateSeedDataset } from "../../../services/seed/seed.generator.js";
import { applySeed, SeedRefused } from "../../../services/seed/seed.service.js";
import { profileDir, displayPath } from "../../../core/profile.js";
import { CliError } from "../errors.js";

interface SeedOptions {
  years?: string;
  seed?: string;
  endDate?: string;
}

export function registerSeedCommand(program: Command): void {
  program
    .command("seed")
    .description("Fill this profile with fabricated sample data (no Plaid, no real bank)")
    .helpGroup("Development:")
    .option("--years <n>", "years of history to generate", "2")
    .option("--seed <n>", "PRNG seed; the same value always produces the same data")
    .option("--end-date <yyyy-mm-dd>", "last day covered (default: today)")
    .addHelpText(
      "after",
      `
Refuses to run in a profile that has real banks linked. To keep sample data
away from your own, seed a separate profile:

  COSTINGLY_HOME=~/costingly-demo costingly seed

The generated banks are marked source='seed'. They are never synced, cannot be
reconnected, and are removed with \`costingly unlink\` like any other bank.`,
    )
    .action(async (options: SeedOptions) => {
      await runSeed(options);
    });
}

export async function runSeed(options: SeedOptions): Promise<void> {
  const years = Number(options.years ?? "2");
  if (!Number.isFinite(years) || years <= 0 || years > 20) {
    throw new CliError("--years must be a number between 0 and 20.");
  }

  const seed = options.seed === undefined ? undefined : Number(options.seed);
  if (seed !== undefined && !Number.isInteger(seed)) {
    throw new CliError("--seed must be an integer.");
  }

  if (options.endDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.endDate)) {
    throw new CliError("--end-date must look like 2026-08-09.");
  }

  console.log(`Profile: ${displayPath(profileDir())}`);

  const dataset = generateSeedDataset({
    years,
    ...(seed === undefined ? {} : { seed }),
    ...(options.endDate === undefined ? {} : { endDate: options.endDate }),
  });

  let summary;
  try {
    summary = await applySeed(dataset);
  } catch (error) {
    // A refusal is a correct outcome with an actionable message, not a stack
    // trace. CliError prints it and sets a non-zero exit code.
    if (error instanceof SeedRefused) throw new CliError(`\n${error.message}`);
    throw error;
  }

  console.log(
    `\nSeeded ${summary.transactions} transactions across ${summary.accounts} accounts ` +
      `at ${summary.items} banks.`,
  );
  console.log(`Covering ${summary.firstDate} to ${summary.lastDate}.\n`);
  console.log("This is invented data. It is not anyone's real money.\n");
}
