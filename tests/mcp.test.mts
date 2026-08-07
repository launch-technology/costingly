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
eq(tools.map((t) => t.name), ["describe_database"], "exactly one tool is advertised");

const tool = tools[0]!;
eq(tool.annotations?.["readOnlyHint"], true, "it is annotated read-only");
eq(tool.annotations?.["destructiveHint"], undefined, "and claims nothing destructive");
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
