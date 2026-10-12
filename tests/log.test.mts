/**
 * The log module — the one way the shared layers write a diagnostic.
 *
 *   1. The line: time, level, message
 *   2. Before configuration: warnings and errors to stderr, information dropped
 *   3. A capture: every level, as produced
 *   4. A file: appended, folder created, redacted on the way in
 *   5. The trim: over the cap, the newest whole lines are kept and the file
 *      ends well under the cap; under the cap, nothing changes
 *   6. Never throws: an unwritable path is complained about once, and the
 *      program carries on; a redactor that throws costs the message, not
 *      the line
 *
 * Plain node, every platform. stderr is observed by swapping process.stderr's
 * write for the duration of a case.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureLog, formatLine, log, trimLogFile } from "../src/platform/runtime/log.js";

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

const HOME = join(tmpdir(), "costingly-log-test");
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

/** Run something while catching what goes to stderr. */
function capturingStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let caught = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    caught += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return caught;
}

const LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (INFO |WARN |ERROR) (.*)$/;

// ---------------------------------------------------------------------------
// 1. The line
// ---------------------------------------------------------------------------
{
  const line = formatLine("warn", "something odd");
  ok(LINE.test(line), `a line is the local time to the second, the level, the message (${line})`);
  eq(LINE.exec(line)?.[2], "something odd", "the message is the rest of the line, as given");
  eq(formatLine("error", "x").slice(20, 25), "ERROR", "the level is padded to a column");
  eq(formatLine("info", "x").slice(20, 25), "INFO ", "so messages line up");
}

// ---------------------------------------------------------------------------
// 2. Before configuration
// ---------------------------------------------------------------------------
{
  configureLog(undefined);
  const said = capturingStderr(() => {
    log.info("quietly");
    log.warn("careful");
    log.error("broken");
  });
  const lines = said.split("\n").filter((l) => l !== "");
  eq(lines.length, 2, "UNCONFIGURED: warnings and errors reach stderr, information does not");
  ok(lines[0]?.includes("WARN  careful") === true, "the warning, as a line");
  ok(lines[1]?.includes("ERROR broken") === true, "the error, as a line");
  ok(!said.includes("quietly"), "AND INFORMATION IS DROPPED — a healthy MCP server stays silent");
}

// ---------------------------------------------------------------------------
// 3. A capture
// ---------------------------------------------------------------------------
{
  const got: string[] = [];
  configureLog((level, message) => void got.push(`${level}:${message}`));
  const said = capturingStderr(() => {
    log.info("a");
    log.warn("b");
    log.error("c");
  });
  eq(got, ["info:a", "warn:b", "error:c"], "a capture receives every level, with the message as given");
  eq(said, "", "and nothing goes to stderr while it does");
  configureLog(undefined);
}

// ---------------------------------------------------------------------------
// 4. A file
// ---------------------------------------------------------------------------
{
  const path = join(HOME, "deeper", "still", "app.log");
  configureLog({ path, maxBytes: 100_000, redact: (text) => text.split("hunter2").join("[hidden]") });
  ok(existsSync(join(HOME, "deeper", "still")), "configuring creates the file's folder");
  const said = capturingStderr(() => {
    log.info("started");
    log.warn("the password hunter2 leaked into a message");
    log.error("stopped");
  });
  eq(said, "", "a configured file takes everything; stderr gets nothing");
  const written = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  eq(written.length, 3, "three lines written, information included");
  ok(written.every((l) => LINE.test(l)), "each a full line");
  ok(written[1]?.includes("[hidden]") === true && !written[1].includes("hunter2"), "THE REDACTOR IS APPLIED TO WHAT IS WRITTEN");
  eq(written[2]?.endsWith("ERROR stopped"), true, "in order");

  configureLog({ path, maxBytes: 100_000 });
  log.info("again");
  eq(readFileSync(path, "utf8").split("\n").filter((l) => l !== "").length, 4, "configuring again appends; it does not start over");
  configureLog(undefined);
}

// ---------------------------------------------------------------------------
// 5. The trim
// ---------------------------------------------------------------------------
{
  const path = join(HOME, "big.log");
  const CAP = 10_000;
  const row = (i: number): string => `row ${String(i).padStart(6, "0")} ${"x".repeat(40)}`;

  eq(trimLogFile(path, CAP), "missing", "trimming a file that does not exist: missing, not an error");

  writeFileSync(path, [row(1), row(2), row(3)].join("\n") + "\n");
  eq(trimLogFile(path, CAP), "unchanged", "a file under the cap is left alone");
  eq(readFileSync(path, "utf8").split("\n")[0], row(1), "to the byte");

  const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
  writeFileSync(path, rows.join("\n") + "\n");
  ok(statSync(path).size > CAP, "a file over the cap…");
  eq(trimLogFile(path, CAP), "trimmed", "…is trimmed");
  const size = statSync(path).size;
  ok(size <= CAP, `to under the cap (${size} bytes)`);
  ok(size >= CAP * 0.6, "with headroom rather than to nothing — so the next trim is a while away");
  const kept = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  eq(kept[kept.length - 1], row(1000), "THE NEWEST LINE IS KEPT");
  ok(/^row \d{6} x{40}$/.test(kept[0] ?? ""), `the oldest kept line is a whole line (${kept[0]?.slice(0, 10)})`);
  ok(kept.every((l, i) => i === 0 || l > (kept[i - 1] ?? "")), "and the lines are still in order");

  // --- the file sink trims itself ---
  const own = join(HOME, "own.log");
  configureLog({ path: own, maxBytes: 5_000 });
  for (let i = 0; i < 200; i++) log.info(`line ${String(i).padStart(4, "0")} ${"y".repeat(50)}`);
  const ownSize = statSync(own).size;
  ok(ownSize <= 5_000, `A FILE SINK KEEPS ITSELF UNDER ITS CAP as it writes (${ownSize} bytes after 200 lines)`);
  const ownLines = readFileSync(own, "utf8").split("\n").filter((l) => l !== "");
  ok(ownLines[ownLines.length - 1]?.includes("line 0199") === true, "and the newest line survived");
  ok(ownLines.every((l) => LINE.test(l)), "every kept line is whole");

  // --- a file already over the cap when configured ---
  writeFileSync(path, rows.join("\n") + "\n");
  configureLog({ path, maxBytes: CAP });
  ok(statSync(path).size <= CAP, "a file over the cap when configured is trimmed at once");
  configureLog(undefined);
}

// ---------------------------------------------------------------------------
// 6. Never throws
// ---------------------------------------------------------------------------
{
  // A path under a FILE cannot be created, on any platform.
  const blocker = join(HOME, "a-file");
  writeFileSync(blocker, "not a folder");
  const path = join(blocker, "cannot", "exist.log");
  const said = capturingStderr(() => {
    configureLog({ path, maxBytes: 1_000 });
    log.error("first");
    log.error("second");
    log.warn("third");
  });
  ok(true, "configuring and writing to an impossible path did not throw");
  const complaints = said.split("\n").filter((l) => l.includes("could not be written"));
  eq(complaints.length, 1, "the failure is complained about ONCE on stderr, not per line");
  ok(complaints[0]?.includes(path) === true, "naming the file");
  configureLog(undefined);
}
{
  // A redactor that throws — the desktop app's reads the settings file, which
  // can be unreadable. The error it throws quotes that file.
  const path = join(HOME, "unredactable.log");
  const said = capturingStderr(() => {
    configureLog({
      path,
      maxBytes: 100_000,
      redact: () => {
        throw new Error('Unexpected token in "plaidSecret": "hunter2"');
      },
    });
    log.error("the database is not usable: hunter2");
    log.info("and again");
  });
  const written = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  eq(written.length, 2, "A REDACTOR THAT THROWS DOES NOT SILENCE THE LOG: both lines land");
  ok(written.every((l) => LINE.test(l)), "each a full line, with its time and level");
  ok(written[0]?.includes("ERROR [message withheld") === true, "saying the message was withheld");
  ok(!readFileSync(path, "utf8").includes("hunter2"), "AND NEITHER THE UNCHECKED MESSAGE NOR THE REDACTOR'S ERROR IS WRITTEN");
  eq(said.split("\n").filter((l) => l.includes("withheld")).length, 1, "stderr is told once");
  ok(!said.includes("hunter2"), "without the redactor's error either");
  configureLog(undefined);
}

rmSync(HOME, { recursive: true, force: true });

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
