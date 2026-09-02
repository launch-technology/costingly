/**
 * Verify the confirmation gate: it must reject anything except the exact
 * environment name, and it must show which environment/database is targeted.
 */

import { fileURLToPath } from "node:url";

/** Repo root, derived from this file — no absolute paths baked in. */
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");


process.env.PLAID_ENV = "production";

import { PassThrough } from "node:stream";

const { describeDatabase } = await import("../src/apps/cli/ui/confirm.js");
const { platform } = await import("../src/domain/project.js");
const displayPath = (p: string) => platform.displayPath(p);
const { join, resolve } = await import("node:path");

/** The cluster path as describeDatabase renders it: resolved, then shortened. */
const expectedCluster = (home: string): string => displayPath(join(resolve(home), "pg18"));

const results: string[] = [];
let failures = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) results.push(`  ok    ${what}`);
  else {
    failures += 1;
    results.push(`  FAIL  ${what}\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- database description -------------------------------------------------
// With several profiles possible on one machine, naming WHICH database is
// about to be emptied is the whole job of this line.
process.env["COSTINGLY_HOME"] = "/tmp/confirm-profile";
const described = describeDatabase();
eq(described.includes(expectedCluster("/tmp/confirm-profile")), true, "names the cluster about to be modified");
eq(described.includes("on this machine"), true, "says it is local");

process.env["COSTINGLY_HOME"] = "/tmp/other-profile";
eq(describeDatabase().includes(expectedCluster("/tmp/other-profile")), true,
   "follows the profile, so it cannot name the wrong database");
delete process.env["COSTINGLY_HOME"];

// --- the typed-phrase gate ------------------------------------------------
// Drive clack's text prompt directly, the same way the picker tests do.
const { text, isCancel } = await import(new URL("../node_modules/@clack/prompts/dist/index.mjs", import.meta.url).href);

async function askWith(keystrokes: string[]): Promise<unknown> {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const pending = text({
    input,
    output,
    message: 'Type "production" to confirm:',
    validate: (value: string) =>
      value === "production" ? undefined : 'Type exactly "production", or press Ctrl-C to abort.',
  });
  for (const key of keystrokes) {
    await new Promise((resolve) => setImmediate(resolve));
    input.write(key);
  }
  return await pending;
}

const ENTER = "\r";
const CTRL_C = String.fromCharCode(3);

const PENDING = Symbol("still-prompting");

/** Resolve to PENDING if the prompt refuses to accept the input. */
async function settles(keystrokes: string[]): Promise<unknown> {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(PENDING), 250));
  return Promise.race([askWith(keystrokes), timeout]);
}

eq(await askWith(["production", ENTER]), "production", "exact phrase is accepted");
eq(isCancel(await askWith([CTRL_C])), true, "ctrl-c cancels");

// A rejected value must leave the prompt open rather than falling through.
eq(await settles(["sandbox", ENTER]), PENDING, "the OTHER environment name is rejected");
eq(await settles(["y", ENTER]), PENDING, "a reflexive y does not satisfy the gate");
eq(await settles(["yes", ENTER]), PENDING, "yes does not satisfy the gate");
eq(await settles([ENTER]), PENDING, "bare enter does not satisfy the gate");
eq(await settles(["Production", ENTER]), PENDING, "wrong capitalisation is rejected");
eq(await settles(["production ", ENTER]), PENDING, "trailing space is rejected");

console.log(results.join("\n"));
console.log(failures === 0 ? `\nAll ${results.length} checks passed.` : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
