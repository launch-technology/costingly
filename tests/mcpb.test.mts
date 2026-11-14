/**
 * The Claude Desktop extension, run as Claude Desktop runs it.
 *
 * The real extension process is started over stdio (through tsx, from source)
 * and driven with the SDK's client, standing in for Claude Desktop. Behind it
 * is the app's real endpoint — the local server, the route table and the ten
 * tools over a real database — on a free port with a token, and the app's
 * connection file written where the extension looks for it.
 *
 *   1. Relaying: the ten tools with the app's own descriptions and
 *      introduction; query, sync and sync_status answer as they do directly;
 *      the app's log is told who asked
 *   2. The app stops and starts again: one call says so, the next works, no
 *      restart of the extension
 *   3. The app moves to another port: the first call after the move works
 *   4. The extension's settings: a wrong token, an unfilled placeholder, a
 *      dead address
 *   5. Nothing written down: never opened
 *   6. Started before the app: one tool and the restart-Claude-Desktop
 *      message; the app reached later; the full list once asked again
 *   7. An app of another major version is refused, both versions named
 *   8. Nothing the extension says names a command; its stderr never holds
 *      the token
 *   9. The raw channel: every stdout line is JSON-RPC, and the process exits
 *      when stdin closes — with the app up, and with it down
 *
 * Plain node, every platform; nothing here imports Electron.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAIN = join(ROOT, "src", "apps", "mcpb", "main.ts");

const HOME = join(tmpdir(), "costingly-mcpb");
const APP_DIR = `${HOME}-desktop`;
const CONNECTION = join(APP_DIR, "mcp.json");
process.env["COSTINGLY_HOME"] = HOME;

const { db, closeDb, server } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { LocalHttpServer } = await import("../src/apps/desktop/main/shell/local-http-server.js");
const { routes } = await import("../src/apps/desktop/main/routes/index.js");
const { linkRouteDependencies } = await import("../src/apps/desktop/main/routes/link.adapter.js");
const { serverInfo } = await import("../src/apps/desktop/main/mcp/server-info.js");
const { CheckCostinglyTool } = await import("../src/apps/desktop/main/mcp/tools/check-costingly.tool.js");
const { DescribeDatabaseTool } = await import("../src/apps/desktop/main/mcp/tools/describe-database.tool.js");
const { QueryTool } = await import("../src/apps/desktop/main/mcp/tools/query.tool.js");
const { SyncTool } = await import("../src/apps/desktop/main/mcp/tools/sync.tool.js");
const { SyncStatusTool } = await import("../src/apps/desktop/main/mcp/tools/sync-status.tool.js");
const { LinkBankTool } = await import("../src/apps/desktop/main/mcp/tools/link-bank.tool.js");
const { RelinkBankTool } = await import("../src/apps/desktop/main/mcp/tools/relink-bank.tool.js");
const { UnlinkBankTool } = await import("../src/apps/desktop/main/mcp/tools/unlink-bank.tool.js");
const { SetupCostinglyTool } = await import("../src/apps/desktop/main/mcp/tools/setup-costingly.tool.js");
const { RestartDatabaseTool } = await import("../src/apps/desktop/main/mcp/tools/restart-database.tool.js");
const { checkCostinglyDependencies, datastoreState, describeDatabaseDependencies, listBanks, queryDependencies, recentLinks } =
  await import("../src/apps/desktop/main/mcp/mcp.adapter.js");
const { SyncService } = await import("../src/apps/desktop/main/features/sync/sync.service.js");
const { UnlinkService } = await import("../src/apps/desktop/main/features/accounts/unlink.service.js");
const { unlinkDependencies } = await import("../src/apps/desktop/main/features/accounts/accounts.adapter.js");
const { DatabaseService } = await import("../src/apps/desktop/main/features/database/database.service.js");
const { databaseDependencies, databaseSources } = await import("../src/apps/desktop/main/features/database/database.adapter.js");
const { databaseSectionReader } = await import("../src/apps/desktop/main/features/database/database.controller.js");
const { explainDatabaseFailure } = await import("../src/apps/desktop/main/features/database/database.presenter.js");
const { describeError, keysPresent } = await import("../src/apps/desktop/main/shared/domain.adapter.js");
const { mcpbVersion } = await import("../src/apps/mcpb/version.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

type ToolOutcome = import("../src/apps/desktop/main/mcp/mcp-handler.js").ToolOutcome;
type SyncSummary = import("../src/domain/services/banks/sync.types.js").SyncSummary;
type LocalHttpServerType = InstanceType<typeof LocalHttpServer>;

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
  await closeDb().catch(() => {});
  await server.stop().catch(() => {});
  for (const dir of [HOME, APP_DIR, `${HOME}-2`, `${HOME}-2-desktop`]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const text = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? "";
const lastText = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

/** A costingly command named in anything the extension says would send the user to a terminal that is being retired. */
const NAMES_A_COMMAND = /costingly\s+(init|migrate|sync|status|stop|link|unlink|uninstall|reset|seed|doctor)\b|`costingly/i;

const environment = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

const summaryOf = (): SyncSummary => ({
  ok: true,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  itemsTotal: 1,
  itemsSucceeded: 1,
  itemsFailed: 0,
  added: 3,
  modified: 0,
  removed: 0,
  results: [{ itemId: "i1", institutionName: "Test Bank", ok: true, added: 3, modified: 0, removed: 0, accounts: 1, pages: 1, initialBackfill: false, updateStatus: null } as SyncSummary["results"][number]],
});

// ---------------------------------------------------------------------------
// The app's endpoint, exactly as the app composes it
// ---------------------------------------------------------------------------

await wipe();
await install();
await db.query(`INSERT INTO items (item_id, institution_name, access_token_enc, status)
             VALUES ('i1', 'Test Bank', 'aXY=.dGFn.Y2lwaGVy', 'active')`);

const sync = new SyncService({ run: async () => summaryOf(), describeError, now: () => new Date(), onChange: () => {} });
const unlinking = new UnlinkService({ ...unlinkDependencies(), exclusively: (work) => sync.runExclusive(work) });
const database = new DatabaseService(databaseDependencies());
const section = databaseSectionReader(databaseSources, database);
const now = (): Date => new Date();
const observed: Array<[string, ToolOutcome, string | undefined]> = [];
const tools = [
  new CheckCostinglyTool(checkCostinglyDependencies()),
  new DescribeDatabaseTool(describeDatabaseDependencies()),
  new QueryTool(queryDependencies()),
  new SyncTool({ state: datastoreState, sync, now, waitMs: 2_000 }),
  new SyncStatusTool({ sync, now }),
  new LinkBankTool({ keysPresent, state: datastoreState, pageAddress: () => "http://127.0.0.1:1/pages/link", takeRecentLinks: recentLinks.takeRecentLinks }),
  new RelinkBankTool({ keysPresent, state: datastoreState, listBanks, reconnectAddress: () => "http://127.0.0.1:1/pages/link", takeRecentRepairs: recentLinks.takeRecentRepairs }),
  new UnlinkBankTool({ unlink: unlinking, listBanks }),
  new SetupCostinglyTool({
    createDatabase: async () => {
      const failure = await database.create();
      return failure === undefined ? undefined : explainDatabaseFailure(failure).problem;
    },
    keysPresent,
  }),
  new RestartDatabaseTool({ restart: () => database.restart(), section }),
];

const TOKEN = "mcpb-test-token-0123456789abcdef0123456789abcdef";
const VERSION = mcpbVersion();

/** The app's endpoint on `port`, reporting `version` as the app's own. */
async function serveApp(port: number, token: string, version = VERSION): Promise<LocalHttpServerType> {
  const http = new LocalHttpServer({
    routes: routes({
      mcp: { info: serverInfo(version), tools, observe: (tool, outcome, client) => void observed.push([tool, outcome, client]) },
      link: linkRouteDependencies(),
    }),
    onRefused: () => {},
  });
  await http.start(port, token);
  return http;
}

/** What the app writes down for local clients. */
async function writeConnection(port: number, token: string): Promise<void> {
  await mkdir(APP_DIR, { recursive: true });
  await writeFile(CONNECTION, `${JSON.stringify({ port, token }, null, 2)}\n`, "utf8");
}

/** A direct client of the app, for comparing answers. */
async function connectDirect(port: number): Promise<InstanceType<typeof Client>> {
  const client = new Client({ name: "direct", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  return client;
}

interface Extension {
  client: InstanceType<typeof Client>;
  stderr(): string;
  close(): Promise<void>;
}

/** The extension as Claude Desktop starts it: a child process over stdio, with Claude Desktop's settings as environment. */
async function startExtension(settings: Record<string, string> = {}, home = HOME): Promise<Extension> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, MAIN],
    env: { ...environment(), COSTINGLY_HOME: home, ...settings },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: "claude-desktop-stand-in", version: "0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

const toolNames = async (client: InstanceType<typeof Client>): Promise<string[]> => (await client.listTools()).tools.map((t) => t.name).sort();
const call = (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

const port = await freePort();
let http: LocalHttpServerType | undefined = await serveApp(port, TOKEN);
await writeConnection(port, TOKEN);
/** Where the app ends up after section 3 moves it. */
let moved = port;

try {
  // =========================================================================
  // 1. Relaying
  // =========================================================================
  const direct = await connectDirect(port);
  const extension = await startExtension();

  const relayed = await extension.client.listTools();
  const straight = await direct.listTools();
  eq(relayed.tools.map((t) => t.name).sort(), straight.tools.map((t) => t.name).sort(), "THE TEN TOOLS ARE RELAYED, by name");
  eq(
    relayed.tools.map((t) => [t.name, t.description, JSON.stringify(t.annotations)]),
    straight.tools.map((t) => [t.name, t.description, JSON.stringify(t.annotations)]),
    "with the app's own descriptions and annotations, unchanged",
  );
  eq(extension.client.getInstructions(), direct.getInstructions(), "and the app's own introduction");
  eq(extension.client.getServerVersion()?.version, VERSION, "the version Claude Desktop sees is the app's");

  const viaExtension = text(await call(extension.client, "query", { sql: "SELECT institution_name, status FROM v_items" }));
  const viaDirect = text(await call(direct, "query", { sql: "SELECT institution_name, status FROM v_items" }));
  eq(viaExtension, viaDirect, "QUERY ANSWERS THE SAME THROUGH THE EXTENSION AS DIRECTLY");
  ok(viaExtension.includes("Test Bank | active"), "and it is the data");
  const refused = await call(extension.client, "query", { sql: "DELETE FROM transactions WHERE true" });
  eq(refused.isError, true, "a refusal is relayed as a refusal");
  ok(text(await call(extension.client, "describe_database")).includes("v_transactions"), "describe_database relays the document");

  const synced = await call(extension.client, "sync");
  ok(synced.isError === false && /Synced 1 of 1 bank/.test(text(synced)), "sync relays and reports the run");
  ok(/started through this endpoint/.test(text(await call(extension.client, "sync_status"))), "sync_status relays, and the app saw the run as a client's");

  ok(
    observed.some(([tool, , client]) => tool === "query" && client === `costingly-mcpb/${VERSION}`),
    "THE APP IS TOLD WHO ASKED: costingly-mcpb and its version",
  );
  ok(observed.some(([, , client]) => client === undefined), "while the direct client, which said nothing, is recorded as nobody in particular");

  // =========================================================================
  // 2. The app stops and starts again
  // =========================================================================
  await http.stop();
  http = undefined;
  const whileDown = await call(extension.client, "query", { sql: "SELECT 1" });
  ok(whileDown.isError === true && /not running/.test(text(whileDown)) && /No restart of Claude Desktop/.test(text(whileDown)), "APP STOPPED MID-SESSION: the call says to start it, and that no restart is needed");
  ok(/Start menu/.test(text(whileDown)), "naming the Start menu");
  http = await serveApp(port, TOKEN);
  ok(text(await call(extension.client, "query", { sql: "SELECT 2 AS two" })).includes("two"), "AND THE NEXT CALL AFTER IT IS BACK WORKS, with the same extension process");

  // =========================================================================
  // 3. The app moves to another port
  // =========================================================================
  await http.stop();
  moved = await freePort();
  http = await serveApp(moved, TOKEN);
  await writeConnection(moved, TOKEN);
  ok(text(await call(extension.client, "query", { sql: "SELECT 3 AS three" })).includes("three"), "APP RESTARTED ON ANOTHER PORT: the first call after the move works — the connection file was read again");
  await extension.close();
  ok(!extension.stderr().includes(TOKEN), "the extension's stderr never contains the token");
  ok(/connected to the app/.test(extension.stderr()), "and says when it connected");

  // =========================================================================
  // 4. The extension's settings
  // =========================================================================
  {
    const wrong = await startExtension({ COSTINGLY_TOKEN: "not-the-token" });
    eq(await toolNames(wrong.client), ["check_costingly"], "A WRONG TOKEN IN THE SETTINGS: one tool is offered");
    const answer = await call(wrong.client, "check_costingly");
    ok(answer.isError !== true && /not the app's current token/.test(text(answer)) && /clear the Token field/.test(text(answer)) && /Connect screen/.test(text(answer)), "and check_costingly explains the token and both fixes");
    ok(/token/i.test(wrong.client.getInstructions() ?? ""), "the introduction says the same");
    const other = await call(wrong.client, "query", { sql: "SELECT 1" });
    ok(other.isError === true && /token/.test(text(other)), "any other tool is an error with the same explanation");
    await wrong.close();
    ok(!wrong.stderr().includes("not-the-token"), "the wrong token is not written to stderr either");
  }
  {
    const placeholder = await startExtension({ COSTINGLY_TOKEN: "${user_config.token}", COSTINGLY_ADDRESS: "${user_config.address}" });
    eq((await toolNames(placeholder.client)).length, 10, "UNFILLED PLACEHOLDERS, as Claude Desktop passes blank fields, mean not set: the app is found by itself");
    await placeholder.close();
  }
  {
    const dead = await freePort();
    const address = `http://127.0.0.1:${dead}/mcp`;
    const wrongAddress = await startExtension({ COSTINGLY_ADDRESS: address });
    eq(await toolNames(wrongAddress.client), ["check_costingly"], "A DEAD ADDRESS IN THE SETTINGS: one tool");
    const answer = text(await call(wrongAddress.client, "check_costingly"));
    ok(answer.includes(address) && /clearing the Address field/.test(answer), "and the message names that address and how to clear it");
    await wrongAddress.close();
  }

  // =========================================================================
  // 5. Nothing written down
  // =========================================================================
  {
    const fresh = await startExtension({}, `${HOME}-2`);
    eq(await toolNames(fresh.client), ["check_costingly"], "NEVER OPENED: one tool");
    ok(/does not seem to be installed/.test(fresh.client.getInstructions() ?? ""), "the introduction says Costingly does not seem to be installed");
    const answer = await call(fresh.client, "check_costingly");
    ok(answer.isError !== true && /never been opened/.test(text(answer)) && /restart Claude Desktop/.test(text(answer)), "and check_costingly says to install and open it, then restart Claude Desktop");
    await fresh.close();
  }

  // =========================================================================
  // 6. Started before the app
  // =========================================================================
  {
    await http.stop();
    http = undefined;
    const early = await startExtension();
    eq(await toolNames(early.client), ["check_costingly"], "STARTED WITH THE APP DOWN: one tool");
    ok(/restart Claude Desktop/.test(early.client.getInstructions() ?? "") && /not running/.test(early.client.getInstructions() ?? ""), "the introduction says to start Costingly and restart Claude Desktop");
    const before = await call(early.client, "check_costingly");
    ok(before.isError !== true && /restart Claude Desktop/.test(text(before)), "check_costingly says the same while the app is down");
    const blocked = await call(early.client, "query", { sql: "SELECT 1" });
    ok(blocked.isError === true && /restart Claude Desktop/.test(text(blocked)), "a tool Claude Desktop has not been told about is an error, with the same explanation");

    http = await serveApp(moved, TOKEN);
    const after = await call(early.client, "check_costingly");
    ok(/^costingly: /.test(text(after)) && /restart Claude Desktop/.test(lastText(after)), "APP UP LATER: check_costingly relays the app's real answer, and adds that Claude Desktop must be restarted to see every tool");
    eq((await toolNames(early.client)).length, 10, "and the full list is there for whenever Claude Desktop asks again");
    await early.close();
  }

  // =========================================================================
  // 7. Another major version
  // =========================================================================
  {
    const otherPort = await freePort();
    const old = await serveApp(otherPort, TOKEN, "9.0.0-test");
    await writeConnection(otherPort, TOKEN);
    const mismatched = await startExtension();
    const seen = observed.length;
    eq(await toolNames(mismatched.client), ["check_costingly"], "DIFFERENT MAJOR VERSIONS: one tool, nothing relayed");
    const answer = text(await call(mismatched.client, "check_costingly"));
    ok(answer.includes("9.0.0-test") && answer.includes(VERSION) && /update this extension/.test(answer), "both versions are named, and which to update");
    eq(observed.length, seen, "AND NO TOOL CALL REACHED THE APP");
    await mismatched.close();
    await old.stop();
    await writeConnection(moved, TOKEN);
  }

  // =========================================================================
  // 8. Wording
  // =========================================================================
  {
    const { NEVER_OPENED, NOT_RUNNING, NOT_RUNNING_AT_START, TOKEN_REJECTED, UNREADABLE, addressUnreachable, incompatible, relayFailed } =
      await import("../src/apps/mcpb/messages.presenter.js");
    const every = [NEVER_OPENED, NOT_RUNNING, NOT_RUNNING_AT_START, TOKEN_REJECTED, UNREADABLE, addressUnreachable("http://x"), incompatible("9.0.0", VERSION), relayFailed("boom")];
    ok(every.every((m) => !NAMES_A_COMMAND.test(m)), "NOTHING THE EXTENSION SAYS NAMES A costingly COMMAND");
    ok(every.every((m) => /Tell the user/.test(m)), "and every message says what to tell the user");
  }
} finally {
  await http?.stop();
}

// ===========================================================================
// 9. The raw channel
// ===========================================================================

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

/** Spawn the real extension, write `lines` to its stdin, then close stdin. */
function drive(lines: string[], holdMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [TSX, MAIN], { stdio: ["pipe", "pipe", "pipe"], env: { ...environment(), COSTINGLY_HOME: HOME } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    for (const line of lines) child.stdin.write(`${line}\n`);
    setTimeout(() => child.stdin.end(), holdMs);
    child.on("close", (code) => resolve({ stdout, stderr, code, ms: Date.now() - started }));
  });
}

const HANDSHAKE = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
];

function parsed(run: Run): { lines: string[]; responses: Array<Record<string, unknown>>; notJson: string[] } {
  const lines = run.stdout.split("\n").filter((l) => l.trim() !== "");
  const responses: Array<Record<string, unknown>> = [];
  const notJson: string[] = [];
  for (const line of lines) {
    try {
      responses.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      notJson.push(line.slice(0, 60));
    }
  }
  return { lines, responses, notJson };
}

http = await serveApp(moved, TOKEN);
const up = await drive(HANDSHAKE, 4000);
await http.stop();
{
  const { lines, responses, notJson } = parsed(up);
  eq(up.code, 0, "WITH THE APP UP: the extension exits cleanly when stdin closes");
  ok(up.ms < 30000, `and promptly — ${up.ms}ms`);
  eq(notJson, [], "EVERY LINE OF STDOUT IS VALID JSON — no banner, no console.log");
  eq(lines.length, 2, "exactly two responses: initialize, tools/list");
  eq((responses[0]?.["result"] as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name, "costingly", "initialize reports the server name");
  eq(((responses[1]?.["result"] as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).length, 10, "and the listing over real stdio has the ten tools");
  ok(!up.stderr.includes(TOKEN), "stderr holds no token");
}

const down = await drive(HANDSHAKE, 4000);
{
  const { lines, responses, notJson } = parsed(down);
  eq(down.code, 0, "WITH THE APP DOWN: the extension still starts and exits cleanly");
  eq(notJson, [], "stdout is still nothing but JSON");
  eq(lines.length, 2, "two responses");
  eq(((responses[1]?.["result"] as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name), ["check_costingly"], "and the listing is the one tool");
}

await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
