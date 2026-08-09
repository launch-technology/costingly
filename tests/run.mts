/**
 * Run every suite in this directory and summarise.
 *
 *   npm test              everything
 *   npm test -- config    only suites whose name contains "config"
 *
 * Each suite is a standalone script that prints its own results and exits 0 or
 * 1 — no framework. They run in **separate processes** on purpose: several
 * mutate `process.env` (COSTINGLY_HOME above all) and start real Postgres
 * clusters, so sharing a process would let one suite's state leak into the
 * next. That isolation is the reason a suite can safely point the whole app at
 * a throwaway profile.
 *
 * Suites needing Plaid credentials skip with instructions rather than fail, so
 * a fresh clone runs everything else green.
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * Cheapest and least side-effecting first, so a broken foundation surfaces
 * before spending a minute on the end-to-end run.
 */
const ORDER = [
  "profile",
  "config",
  "smoke",
  "picker",
  "confirm",
  "schema",
  "views",
  "seed",
  "readonly",
  "mcp",
  "init-flow",
  "concurrency",
  "e2e",
];

interface Outcome {
  name: string;
  code: number;
  checks: number;
  skipped: boolean;
  output: string;
}

function run(file: string, name: string): Promise<Outcome> {
  return new Promise((resolve) => {
    // tsx from node_modules/.bin, invoked through the current node so the suite
    // inherits exactly this runtime.
    const child = spawn(
      process.execPath,
      [join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs"), file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));

    child.on("close", (code) => {
      const passed = /All (\d+) checks passed/.exec(output);
      resolve({
        name,
        code: code ?? 1,
        checks: passed ? Number(passed[1]) : 0,
        skipped: output.includes("SKIPPED"),
        output,
      });
    });
  });
}

const filter = process.argv[2];
const files = (await readdir(HERE))
  .filter((f) => f.endsWith(".test.mts"))
  .map((f) => ({ file: join(HERE, f), name: f.replace(".test.mts", "") }))
  .filter(({ name }) => filter === undefined || name.includes(filter))
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.name);
    const ib = ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

if (files.length === 0) {
  console.error(filter ? `No suite matching "${filter}".` : "No suites found.");
  process.exit(1);
}

console.log("");
const results: Outcome[] = [];
for (const { file, name } of files) {
  process.stdout.write(`  ${name.padEnd(14)}`);
  const outcome = await run(file, name);
  results.push(outcome);

  if (outcome.code !== 0) console.log("FAILED");
  else if (outcome.skipped) console.log("skipped");
  else console.log(`${outcome.checks} checks`);
}

const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.code === 0 && r.skipped);
const total = results.reduce((sum, r) => sum + r.checks, 0);

// Only failures get their output printed — a green run should stay quiet.
for (const r of failed) {
  console.log(`\n${"─".repeat(60)}\n${r.name}\n${"─".repeat(60)}`);
  console.log(r.output.trimEnd());
}

console.log("");
if (failed.length > 0) {
  console.log(`  ${failed.length} suite(s) FAILED — ${total} checks passed elsewhere.`);
  process.exit(1);
}
console.log(
  `  ${total} checks passed across ${results.length - skipped.length} suite(s)` +
    (skipped.length > 0
      ? `, ${skipped.length} skipped.\n\n  Skipped suites need Plaid sandbox credentials:\n    npm run setup:sandbox`
      : "."),
);
console.log("");
