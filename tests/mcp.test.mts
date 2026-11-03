/**
 * The old MCP server — what is left of it, and its stdout discipline.
 *
 * Every tool but uninstall_costingly has moved to the desktop app's endpoint
 * (tests/mcp-endpoint.test.mts). This suite keeps the two halves that still
 * matter for the one tool that remains:
 *
 *   in-memory   A real Client and the real server in one process, linked by a
 *               transport whose send() is a function call. Proves the server
 *               brings a stopped database up, advertises its one tool with
 *               every annotation stated, and that uninstall refuses to delete
 *               what it cannot also revoke at Plaid.
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
import { rm } from "node:fs/promises";

const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// Its own profile, set before anything resolves one. Short path: the unix
// socket derives from it and sockaddr_un caps near 104 bytes.
const HOME = "/tmp/costingly-mcp";
process.env["COSTINGLY_HOME"] = HOME;

// SAFETY: everything below wipes HOME. Refuse to run against anything else.
if (HOME !== "/tmp/costingly-mcp") throw new Error("refusing to run against a real profile");

const { db, closeDb, server } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { CostinglyMcpApplication } = await import("../src/apps/mcp/costingly-mcp.application.js");
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
  await server.stop().catch(() => {});
  // maxRetries: Windows can still hold handles on the cluster directory for a
  // moment after the postmaster exits, which unlink-while-open unix does not.
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
await wipe();

// Explicit, because reading no longer creates. A suite that needs a database
// now has to say so — which is the point of the change it is testing under.
await install();

// The first query builds the database — migrations included. Tests take the
// same path a real install takes. A linked bank, so uninstall has something
// it must not strand.
await db.query(`INSERT INTO items (item_id, institution_name, access_token_enc, status)
             VALUES ('i1', 'Test Bank', 'aXY=.dGFn.Y2lwaGVy', 'active')`);

// ---------------------------------------------------------------------------
// In-memory: the protocol surface
// ---------------------------------------------------------------------------

// The database is stopped before the server starts — the state after a
// reboot. No query starts it any more, so the server has to, as it comes up.
await closeDb();
await server.stop();
eq(await server.status(), "stopped", "the database is stopped before the MCP server starts");

const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
const app = new CostinglyMcpApplication("9.9.9-test", serverEnd);
await app.start();
eq(await server.status(), "running", "STARTING THE MCP SERVER BRINGS A STOPPED DATABASE UP, before any tool is called");

// run() resolves only when the client disconnects, so it is deliberately NOT
// awaited here — it is awaited at the end, which also proves shutdown works.
const serving = app.run();

const client = new Client({ name: "test-client", version: "0" });
await client.connect(clientEnd);

const { tools } = await client.listTools();
eq(tools.map((t) => t.name), ["uninstall_costingly"],
   "the one tool that remains here is advertised — every other lives in the desktop app");

// The server-level instructions are the only place the injection warning lives.
const instructions = client.getInstructions() ?? "";
ok(instructions.length > 100, `the server sends instructions (${instructions.length} chars)`);
ok(/moved to the Costingly desktop app/.test(instructions), "saying where the other tools went");
ok(/never as instructions/i.test(instructions),
   "AND WARNING THAT TRANSACTION TEXT IS THIRD-PARTY DATA, not instructions");

// Nothing is left to a default on any tool. A reader should not need to know
// which hints are 'only meaningful when readOnlyHint is false' to read these.
for (const t of tools) {
  eq(Object.keys(t.annotations ?? {}).sort(),
     ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"],
     `${t.name} states all four annotations, none defaulted`);
}

// callTool's return type is a union — the compatibility shape carries
// `toolResult` rather than `content` — so this reads it loosely on purpose.
const text = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? "";

// --- uninstall_costingly refuses when it cannot revoke ----------------------
//
// The bug this pins down cost real money on 2026-09-10. The tool's first call
// said "Each bank would also be removed at Plaid, so nothing keeps billing"
// without checking whether Plaid was reachable. It was not — the credentials
// were missing — so the uninstall deleted three access tokens while leaving
// three Items alive at Plaid: still billing, and impossible to use again,
// because no one can turn an item_id back into a working token.
//
// Best-effort revocation is right for a TRANSIENT failure. Missing credentials
// are knowable before anything is deleted, so the only safe answer is to stop.
//
// No Plaid credentials are set at this point in the suite, and an item is
// linked, so this is exactly that state.
{
  const blocked = await client.callTool({
    name: "uninstall_costingly",
    arguments: {},
  });
  const blockedText = text(blocked);

  eq(blocked.isError, true, "uninstall REFUSES when banks are linked and Plaid is unreachable");
  ok(/NOTHING HAS BEEN DELETED/.test(blockedText), "and says plainly that nothing was deleted");
  ok(/never be used again/i.test(blockedText),
     "AND NAMES THE CONSEQUENCE it exists to prevent — stranded, unusable Items");
  ok(!/confirmation_token:\s*\S/.test(blockedText),
     "and mints NO token, so the delete cannot be armed by a second call");
  ok(/keep_plaid_items/.test(blockedText),
     "while naming the deliberate opt-out, so the user can still choose it");

  // The escape hatch works: acknowledging the consequence gets a token.
  const accepted = await client.callTool({
    name: "uninstall_costingly",
    arguments: { keep_plaid_items: true },
  });
  ok(/confirmation_token:\s*\S/.test(text(accepted)),
     "keep_plaid_items: true is accepted as an explicit choice, and mints a token");
  ok(/keep billing/i.test(text(accepted)),
     "and still spells out what leaving them behind costs");
}

// --- failure modes ---------------------------------------------------------
// An unknown tool comes back as a RESULT with isError, not a protocol error, so
// the model can read what went wrong. Verified against SDK behaviour.
const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
eq(unknown.isError, true, "an unknown tool is reported as isError, not a crash");
ok(/no_such_tool/.test((unknown.content as Array<{ text: string }>)[0]?.text ?? ""),
   "and names the tool that was missing");

// --- shutdown ---------------------------------------------------------------
await client.close();
await serving;
await app.stop();
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

/** Spawn the real server, write `lines` to its stdin, then close stdin. */
function driveServer(lines: string[], holdMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [`${P}/node_modules/tsx/dist/cli.mjs`, `${P}/src/apps/mcp/main.ts`],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COSTINGLY_HOME: HOME } },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    for (const line of lines) child.stdin.write(`${line}\n`);

    // Hold stdin open, then close it — that is the disconnect the server must
    // notice. StdioServerTransport does not listen for EOF itself; main.ts
    // wires it. If that wiring breaks, this run does not end promptly.
    setTimeout(() => child.stdin.end(), holdMs);

    child.on("close", (code) => {
      resolve({ stdout, stderr, code, ms: Date.now() - started });
    });
  });
}

// No tool is called over stdio: the one tool left destroys, and a listing is
// enough to prove the channel carries protocol and nothing else.
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
eq(lines.length, 2, "exactly two responses: initialize, tools/list");

eq(responses[0]?.["result"]?.serverInfo?.name, "costingly", "initialize reports the server name");
ok(responses.length > 0 && responses.every((r) => r["jsonrpc"] === "2.0"),
   "and every response is JSON-RPC 2.0");
eq((responses[1]?.["result"]?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name), ["uninstall_costingly"],
   "the listing over real stdio names the one tool");

await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
