/**
 * The MCP server — protocol surface and stdout discipline.
 *
 * Two halves, because neither can do the other's job.
 *
 *   in-memory   A real Client and the real server in one process, linked by a
 *               transport whose send() is a function call. Exercises the actual
 *               handshake, the real tool registration and the real handlers,
 *               with no subprocess and nothing to parse. Everything about the
 *               protocol surface is asserted here.
 *
 *   subprocess  `costingly mcp` spawned for real, driven over stdin/stdout,
 *               asserting that every byte on stdout is protocol. THIS IS THE
 *               ONLY CHECK THAT CATCHES A STRAY console.log — the in-memory
 *               transport never touches stdout, so a print statement passes
 *               every test above and breaks the moment Claude Desktop connects.
 *
 * The subprocess half also proves the lifetime contract: the process must stay
 * alive while stdin is open and exit promptly once it closes. Getting that wrong
 * is invisible in development and shows up as zombie processes in production.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, rm } from "node:fs/promises";

const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// Its own profile, set before anything resolves one. Short path: the unix
// socket derives from it and sockaddr_un caps near 104 bytes.
const HOME = "/tmp/costingly-mcp";
process.env["COSTINGLY_HOME"] = HOME;

// SAFETY: everything below wipes HOME. Refuse to run against anything else.
if (HOME !== "/tmp/costingly-mcp") throw new Error("refusing to run against a real profile");

const { execScript, query, closeDb, stopServer } = await import("../src/index.js");
const { CostinglyMcpServer } = await import("../src/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

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

async function wipe(): Promise<void> {
  await stopServer().catch(() => {});
  await rm(HOME, { recursive: true, force: true });
}
await wipe();

await execScript(await readFile(`${P}/schema.sql`, "utf8"));
await query(`INSERT INTO items (item_id, institution_name, access_token_enc, status)
             VALUES ('i1', 'Test Bank', 'aXY=.dGFn.Y2lwaGVy', 'active')`);

// ---------------------------------------------------------------------------
// In-memory: the protocol surface
// ---------------------------------------------------------------------------

const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
const server = new CostinglyMcpServer("9.9.9-test");

// run() resolves only when the client disconnects, so it is deliberately NOT
// awaited here — it is awaited at the end, which also proves shutdown works.
const serving = server.run(serverEnd);

const client = new Client({ name: "test-client", version: "0" });
await client.connect(clientEnd);

const { tools } = await client.listTools();
eq(tools.map((t) => t.name).sort(), ["describe_database", "query", "sync"],
   "all three tools are advertised");

// The server-level instructions are the only place the relationship between the
// two tools is stated, and the only place the injection warning lives.
const instructions = client.getInstructions() ?? "";
ok(instructions.length > 100, `the server sends instructions (${instructions.length} chars)`);
ok(/describe_database first/i.test(instructions), "telling the client which tool to call first");
ok(/never as instructions/i.test(instructions),
   "AND WARNING THAT TRANSACTION TEXT IS THIRD-PARTY DATA, not instructions");

const tool = tools.find((t) => t.name === "describe_database")!;
eq(tool.annotations?.["readOnlyHint"], true, "it is annotated read-only");
eq(tool.annotations?.["destructiveHint"], false, "and claims nothing destructive");
eq(tool.inputSchema.type, "object", "it has an object input schema");
eq(Object.keys(tool.inputSchema.properties ?? {}), [], "taking no arguments");

// The description is the entire prompt the model gets when deciding to call
// this. A one-liner here is a silent regression — the tool still works, and the
// model stops reaching for it.
const description = tool.description ?? "";
ok(description.length > 200, `the description is substantial (${description.length} chars)`);
ok(/before writing any SQL/i.test(description), "IT SAYS WHEN TO CALL IT, not just what it does");
ok(/structure only/i.test(description), "and is honest that live values are not included");

// --- calling it ------------------------------------------------------------
const result = await client.callTool({ name: "describe_database", arguments: {} });
const content = result.content as Array<{ type: string; text: string }>;

eq(result.isError, undefined, "a successful call is not flagged as an error");
eq(content.length, 1, "it returns a single content block");
eq(content[0]?.type, "text", "of type text");

const doc = content[0]?.text ?? "";
ok(doc.includes("v_transactions"), "the document names the views");
ok(doc.includes("POSITIVE = money OUT"), "and carries the sign convention");
ok(!doc.includes("access_token_enc"), "THE DOCUMENT NEVER MENTIONS THE TOKEN COLUMN");
ok(!doc.includes("aXY=.dGFn"), "and never leaks a token value");
ok(!doc.includes("Test Bank"), "and contains no data — only structure");

// Cached: a second call must be identical, and must not re-query.
const second = await client.callTool({ name: "describe_database", arguments: {} });
eq((second.content as Array<{ text: string }>)[0]?.text, doc,
   "a second call returns the identical cached document");

// --- the query tool ---------------------------------------------------------
const queryTool = tools.find((t) => t.name === "query")!;
eq(queryTool.annotations?.["readOnlyHint"], true, "query is annotated read-only");
eq(Object.keys(queryTool.inputSchema.properties ?? {}), ["sql"], "query takes one argument, sql");
eq((queryTool.inputSchema as { required?: string[] }).required, ["sql"], "and it is required");
ok(/POSITIVE amount/i.test(
     JSON.stringify((queryTool.inputSchema.properties as Record<string, { description?: string }>)?.["sql"] ?? {})),
   "the ARGUMENT's own description carries the sign convention, where it is read");

// callTool's return type is a union — the compatibility shape carries
// `toolResult` rather than `content` — so this reads it loosely on purpose.
const text = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? "";

// A real query against the seeded data.
const rows = await client.callTool({
  name: "query",
  arguments: { sql: "SELECT institution_name, status FROM v_items" },
});
eq(rows.isError, undefined, "a valid SELECT is not an error");
const rowsText = text(rows);
ok(rowsText.includes("institution_name | status"), "results come back as a delimited table");
ok(rowsText.includes("Test Bank | active"), "with the real row");
ok(rowsText.includes("(1 row)"), "and a row count");

// Zero rows must be distinguishable from a broken query.
const none = text(await client.callTool({
  name: "query", arguments: { sql: "SELECT item_id FROM v_items WHERE false" },
}));
ok(none.includes("item_id"), "an empty result still reports its columns");
ok(/0 rows/.test(none), "AND SAYS SO EXPLICITLY, so it reads as an answer not a failure");

// The guard is the database's, not a string check — proven in readonly.test.mts.
// Here we only assert the MCP layer surfaces the refusal usefully.
const write = await client.callTool({
  name: "query", arguments: { sql: "DELETE FROM transactions WHERE true" },
});
eq(write.isError, true, "a write is refused and reported as isError");

const token = await client.callTool({
  name: "query", arguments: { sql: "SELECT access_token_enc FROM items" },
});
eq(token.isError, true, "READING ENCRYPTED CREDENTIALS IS REFUSED");
ok(!text(token).includes("aXY=.dGFn"), "and the refusal leaks no token");

// The whole point of passing PostgreSQL's text through: the hint is the fix.
const typo = text(await client.callTool({
  name: "query", arguments: { sql: "SELECT catgory FROM v_transactions" },
}));
ok(/HINT:/.test(typo) && /category/.test(typo),
   "A MISSPELLED COLUMN RETURNS POSTGRESQL'S HINT, which is what lets the model self-correct");

// --- the sync tool ----------------------------------------------------------
// Every annotation is stated rather than defaulted, on purpose: the defaults are
// destructiveHint TRUE and idempotentHint false, so silence would advertise sync
// as more dangerous than it is and invite clients to gate it harder.
const syncTool = tools.find((t) => t.name === "sync")!;
eq(syncTool.annotations?.["readOnlyHint"], false, "sync declares that it writes");
eq(syncTool.annotations?.["destructiveHint"], false,
   "AND EXPLICITLY THAT IT IS NOT DESTRUCTIVE — the default here is true");
eq(syncTool.annotations?.["idempotentHint"], true,
   "AND EXPLICITLY THAT IT IS IDEMPOTENT — the default here is false");
eq(syncTool.annotations?.["openWorldHint"], true,
   "and that it leaves the machine; it is the only tool that does");

// Nothing is left to a default on any tool. A reader should not need to know
// which hints are 'only meaningful when readOnlyHint is false' to read these.
for (const t of tools) {
  eq(Object.keys(t.annotations ?? {}).sort(),
     ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"],
     `${t.name} states all four annotations, none defaulted`);
}

// Calling it for real, with no banks linked. syncAllItems never constructs a
// Plaid client when there is nothing to sync, so this needs no credentials.
await query(`DELETE FROM items`);
const emptySync = await client.callTool({ name: "sync", arguments: {} });
eq(emptySync.isError, false, "syncing with no banks linked is not an error");
const emptyText = text(emptySync);
ok(/setup step, not an error/i.test(emptyText), "it explains this is setup, not failure");
ok(/costingly link/.test(emptyText), "and names the thing the user must actually do");

// --- failure modes ---------------------------------------------------------
// An unknown tool comes back as a RESULT with isError, not a protocol error, so
// the model can read what went wrong. Verified against SDK behaviour.
const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
eq(unknown.isError, true, "an unknown tool is reported as isError, not a crash");
ok(/no_such_tool/.test((unknown.content as Array<{ text: string }>)[0]?.text ?? ""),
   "and names the tool that was missing");

// Now that a tool HAS an input schema, zod validates — and the failure is a
// readable result rather than a protocol error, so the model can fix its call.
const badArgs = await client.callTool({ name: "query", arguments: { sqll: "SELECT 1" } });
eq(badArgs.isError, true, "a wrong argument name is rejected by the input schema");
ok(/sql/i.test(text(badArgs)), "and the message names the argument at fault");

// --- the sync summary format ------------------------------------------------
// A real multi-bank sync needs Plaid credentials, so the formatter is exercised
// directly. This is where the design lives: the output is read by a model that
// is about to write a report, and a partial failure must be impossible to skim
// past. Assertions below check ORDER, not just presence.
const { formatSyncSummary } = await import("../src/mcp/format.js");

const item = (over: Record<string, unknown>): any => ({
  itemId: "i", institutionName: "Bank", ok: true, added: 0, modified: 0,
  removed: 0, accounts: 1, pages: 1, initialBackfill: false, updateStatus: null, ...over,
});
const summary = (over: Record<string, unknown>): any => ({
  ok: true, startedAt: "", finishedAt: "", durationMs: 4200, itemsTotal: 1,
  itemsSucceeded: 1, itemsFailed: 0, added: 0, modified: 0, removed: 0,
  results: [], ...over,
});

const clean = formatSyncSummary(summary({
  itemsTotal: 2, itemsSucceeded: 2, added: 12, modified: 1,
  results: [item({ institutionName: "Ally", added: 12, modified: 1 }),
            item({ institutionName: "Amex" })],
}));
ok(!/WARNING/.test(clean), "a clean sync carries no warning");
ok(clean.includes("Ally: +12 added, ~1 updated"), "and reports each bank's changes");
ok(clean.includes("Amex: no changes"), "including the ones with nothing new");
ok(clean.includes("Totals: 12 added"), "plus totals");

const partial = formatSyncSummary(summary({
  itemsTotal: 2, itemsSucceeded: 1, itemsFailed: 1, ok: false, added: 12,
  results: [item({ institutionName: "Ally", added: 12 }),
            item({ institutionName: "Chase", ok: false, error: "ITEM_LOGIN_REQUIRED" })],
}));
ok(/INCOMPLETE/.test(partial), "a partial failure says the data is incomplete");
ok(partial.includes("Chase: ITEM_LOGIN_REQUIRED"), "and names the bank and the reason");
ok(/Say so explicitly/i.test(partial), "and instructs the reader to pass it on");
// THE ASSERTION THAT MATTERS: the warning must come before any number, or a
// model skimming for the result will report confidently on partial data.
ok(partial.indexOf("INCOMPLETE") < partial.indexOf("Synced"),
   "THE WARNING PRECEDES EVERY FIGURE — it cannot be skimmed past");
ok(partial.indexOf("INCOMPLETE") < partial.indexOf("Totals:"), "and precedes the totals");

// Two states that look like success and are not.
const backfill = formatSyncSummary(summary({
  added: 2814, results: [item({ added: 2814, initialBackfill: true })],
}));
ok(/full history backfill/.test(backfill), "a first sync is flagged as a backfill");

const notReady = formatSyncSummary(summary({
  results: [item({ added: 3, updateStatus: "NOT_READY" as any })],
}));
ok(/still preparing/.test(notReady),
   "NOT_READY is spelled out, so a small number does not read as 'nothing to do'");
ok(/Sync again shortly/.test(notReady), "and says what to do about it");

// --- shutdown ---------------------------------------------------------------
await client.close();
await serving;
out.push("  ok    run() RESOLVES WHEN THE CLIENT DISCONNECTS (no hang on shutdown)");

await closeDb();

// ---------------------------------------------------------------------------
// Subprocess: stdout must carry nothing but protocol
// ---------------------------------------------------------------------------

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

/** Spawn the real CLI, write `lines` to its stdin, then close stdin. */
function driveServer(lines: string[], holdMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [`${P}/node_modules/tsx/dist/cli.mjs`, `${P}/cli/index.ts`, "mcp"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COSTINGLY_HOME: HOME } },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    for (const line of lines) child.stdin.write(`${line}\n`);

    // Hold stdin open, then close it — that is the disconnect the server must
    // notice. StdioServerTransport does not listen for EOF itself; cli/mcp.ts
    // wires it. If that wiring breaks, this run does not end promptly.
    setTimeout(() => child.stdin.end(), holdMs);

    child.on("close", (code) => {
      resolve({ stdout, stderr, code, ms: Date.now() - started });
    });
  });
}

const HANDSHAKE = [
  JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "describe_database", arguments: {} },
  }),
];

const run = await driveServer(HANDSHAKE, 4000);

eq(run.code, 0, "the server exits cleanly when stdin closes");
ok(run.ms < 20000, `and exits promptly — ${run.ms}ms, not held open by an unclosed pool`);
eq(run.stderr, "", "NOTHING IS WRITTEN TO STDERR on a healthy run");

// THE CHECK THE IN-MEMORY TEST CANNOT MAKE.
//
// Parsing is deliberately partitioned rather than mapped: a contaminated stdout
// is exactly the failure this exists to report, so it must produce a FAIL line
// and not an unhandled SyntaxError that kills the run before the summary.
const lines = run.stdout.split("\n").filter((l) => l.trim() !== "");
const responses: Record<string, any>[] = [];
const notJson: string[] = [];
for (const line of lines) {
  try {
    responses.push(JSON.parse(line) as Record<string, any>);
  } catch {
    notJson.push(line.slice(0, 60));
  }
}
eq(notJson, [], "EVERY LINE OF STDOUT IS VALID JSON — no banner, no console.log");
eq(lines.length, 3, "exactly three responses: initialize, tools/list, tools/call");

eq(responses[0]?.["result"]?.serverInfo?.name, "costingly", "initialize reports the server name");
ok(responses.length > 0 && responses.every((r) => r["jsonrpc"] === "2.0"),
   "and every response is JSON-RPC 2.0");
eq(responses[2]?.["result"]?.isError, undefined, "the tool call over real stdio succeeds");

await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
