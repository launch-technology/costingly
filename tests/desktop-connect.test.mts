/**
 * The Connect screen and the MCP endpoint, driven through the window and
 * through a real MCP client at the same time.
 *
 *   1. What it shows: the address, a hidden token that Show reveals and Hide
 *      conceals, and the Status screen's fourth section agreeing with it
 *   2. Copy: the address and the token land on the clipboard, read back
 *      through Electron's clipboard in the main process
 *   3. A real client: the shown address and token connect; exactly three
 *      tools; each answers; a wrong token is refused
 *   4. In the tray: the window closed, a query still answers; the database
 *      stopped from Status, a query is explained and the database stays stopped
 *   5. Quit: nothing listens afterwards; relaunched, the address and token
 *      are the ones from before
 *   6. The recorded port held by something else: the next one is used, and
 *      both screens say the address changed
 *   7. The app log: the endpoint, the refusal and each tool call are there;
 *      the token and the query's text are not
 *
 * THIS SUITE OVERWRITES THE CLIPBOARD of whoever runs it, and holds a port
 * open on purpose for one launch. Windows-only, like the app. Skips elsewhere.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";

import {
  buildDesktop,
  closeWindow,
  createChecks,
  expectHeadline,
  expectVisible,
  launch,
  quit,
  showWindow,
  skipUnlessWindows,
  until,
} from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-connect-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const checks = createChecks(12);
const { eq, ok } = checks;

async function wipe(): Promise<void> {
  await closeDb().catch(() => {});
  await server.stop().catch(() => {});
  for (const dir of [HOME, DESKTOP]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
await wipe();
await buildDesktop(checks);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_LOG = join(DESKTOP, "costingly.log");
const CONNECTION = join(DESKTOP, "mcp.json");
const ADDRESS = /^http:\/\/127\.0\.0\.1:(\d+)\/mcp$/;
const SECRET = "placeholder-secret-value-xyz";

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

async function goToConnect(page: Page): Promise<void> {
  await page.getByTestId("nav-connect").click();
  await page.locator("[data-testid='connect-screen']:not([data-state='loading'])").waitFor({ timeout: 15_000 });
}

const shownAddress = async (page: Page): Promise<string> => (await page.getByTestId("connect-address").textContent()) ?? "";
const clipboard = (app: ElectronApplication): Promise<string> => app.evaluate(({ clipboard: c }) => c.readText());

/** What a tool said, read loosely: callTool's return type is a union. */
const text = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? "";

async function connect(address: string, token: string): Promise<InstanceType<typeof Client>> {
  const client = new Client({ name: "connect-suite", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(address), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}
const canConnect = (address: string, token: string): Promise<boolean> =>
  connect(address, token).then(
    async (client) => {
      await client.close();
      return true;
    },
    () => false,
  );

await writeConfig({
  plaidClientId: "placeholder-client-id",
  plaidSecret: SECRET,
  encryptionKey: generateEncryptionKey(),
});
await install();
await closeDb();
await server.stop();

let held: Server | undefined;
try {
  // =========================================================================
  // 1. What it shows
  // =========================================================================

  let { app, page } = await open();
  eq(
    await page.getByRole("navigation", { name: "Screens" }).getByRole("button").allInnerTexts(),
    ["Status", "Accounts", "Transactions", "Settings", "Logs", "Connect"],
    "the sidebar lists Connect last, below Logs",
  );

  await expectHeadline(checks, page, "mcp", /^Running$/, "THE STATUS SCREEN HAS A FOURTH SECTION, MCP endpoint, and it is Running");

  await goToConnect(page);
  eq(await page.getByTestId("connect-screen").getAttribute("data-state"), "running", "the Connect screen says the endpoint is running");
  const address = await shownAddress(page);
  ok(ADDRESS.test(address), `THE ADDRESS IS SHOWN: ${address}`);
  await page.getByTestId("nav-status").click();
  await expectHeadline(checks, page, "mcp", /^Running$/, "back on Status, the section is still Running");
  ok(((await page.getByTestId("section-mcp").textContent()) ?? "").includes(address), "and it names the same address");
  await goToConnect(page);

  eq(await page.getByTestId("connect-token").getAttribute("data-hidden"), "true", "THE TOKEN IS HIDDEN");
  ok(!/[0-9a-f]{32}/.test((await page.getByTestId("connect-token").textContent()) ?? ""), "and nothing token-like is on the screen");
  await page.getByTestId("connect-show-token").click();
  await page.locator("[data-testid='connect-token'][data-hidden='false']").waitFor({ timeout: 10_000 });
  const token = (await page.getByTestId("connect-token").textContent()) ?? "";
  ok(/^[0-9a-f]{64}$/.test(token), "Show reveals it: 64 hex characters");
  await page.getByTestId("connect-hide-token").click();
  eq(await page.getByTestId("connect-token").getAttribute("data-hidden"), "true", "and Hide conceals it again");

  // =========================================================================
  // 2. Copy
  // =========================================================================

  await app.evaluate(({ clipboard: c }) => c.writeText("something else entirely"));
  await page.getByTestId("connect-copy-address").click();
  await expectVisible(checks, page.getByTestId("connect-copied"), "Copy address confirms itself");
  eq(await clipboard(app), address, "AND THE CLIPBOARD HOLDS THE ADDRESS");

  await app.evaluate(({ clipboard: c }) => c.writeText("something else entirely"));
  await page.getByTestId("connect-copy-token").click();
  await expectVisible(checks, page.getByTestId("connect-copied"), "Copy token confirms itself, with the token still hidden");
  eq(await clipboard(app), token, "AND THE CLIPBOARD HOLDS THE TOKEN");

  // =========================================================================
  // 3. A real client
  // =========================================================================

  const client = await connect(address, token);
  const { tools } = await client.listTools();
  eq(tools.map((t) => t.name).sort(), ["check_costingly", "describe_database", "query"], "A CLIENT WITH THE SHOWN ADDRESS AND TOKEN IS OFFERED EXACTLY THREE TOOLS");
  ok(/^costingly: /.test(text(await client.callTool({ name: "check_costingly", arguments: {} }))), "check_costingly answers");
  ok(text(await client.callTool({ name: "describe_database", arguments: {} })).includes("v_transactions"), "describe_database answers");
  const one = await client.callTool({ name: "query", arguments: { sql: "SELECT 1 AS one_marker_column" } });
  ok(one.isError === undefined && text(one).includes("one_marker_column") && text(one).includes("(1 row)"), "and query answers with a row");

  eq(await canConnect(address, "0".repeat(64)), false, "A WRONG TOKEN IS REFUSED");

  // =========================================================================
  // 4. In the tray
  // =========================================================================

  await closeWindow(app);
  ok(text(await client.callTool({ name: "query", arguments: { sql: "SELECT 2 AS two" } })).includes("two"), "WITH THE WINDOW CLOSED TO THE TRAY, A QUERY STILL ANSWERS");

  await showWindow(app);
  await page.getByTestId("nav-status").click();
  await page.getByTestId("database-action-stop").click();
  await expectHeadline(checks, page, "database", /^Stopped$/, "the database is stopped from Status");
  const stopped = await client.callTool({ name: "query", arguments: { sql: "SELECT 3" } });
  ok(stopped.isError === true && /not running/.test(text(stopped)) && /Status screen/.test(text(stopped)), "A QUERY AGAINST THE STOPPED DATABASE IS EXPLAINED, pointing at the Status screen");
  eq(await server.status(), "stopped", "and the database is still stopped — the query started nothing");
  await client.close();

  // =========================================================================
  // 5. Quit, and come back
  // =========================================================================

  const before = JSON.parse(readFileSync(CONNECTION, "utf8")) as { port: number; token: string };
  eq([typeof before.port, before.token], ["number", token], "the port and the token are remembered in the app's own folder");

  eq(await quit(app), 0, "Quit, exit code 0");
  eq(await canConnect(address, token), false, "AFTER QUIT, NOTHING LISTENS");

  ({ app, page } = await open());
  await goToConnect(page);
  eq(await shownAddress(page), address, "RELAUNCHED, THE ADDRESS IS THE SAME");
  await page.getByTestId("connect-show-token").click();
  await page.locator("[data-testid='connect-token'][data-hidden='false']").waitFor({ timeout: 10_000 });
  eq(await page.getByTestId("connect-token").textContent(), token, "and so is the token");
  eq(await page.getByTestId("connect-moved").count(), 0, "with no notice of a move");
  eq(await quit(app), 0, "Quit, exit code 0");

  // =========================================================================
  // 6. The recorded port is taken
  // =========================================================================

  const port = Number(ADDRESS.exec(address)?.[1]);
  held = createServer();
  await new Promise<void>((resolve, reject) => {
    held!.once("error", reject);
    held!.listen(port, "127.0.0.1", () => resolve());
  });

  ({ app, page } = await open());
  await goToConnect(page);
  const moved = await shownAddress(page);
  ok(ADDRESS.test(moved) && moved !== address, `THE PORT HELD BY SOMETHING ELSE: THE NEXT ONE IS USED (${moved})`);
  await expectVisible(checks, page.getByTestId("connect-moved"), "and the Connect screen says the address changed");
  ok(((await page.getByTestId("connect-moved").textContent()) ?? "").includes(address), "naming the old one");
  await page.getByTestId("nav-status").click();
  await expectHeadline(checks, page, "mcp", /^Running$/, "Status: still Running");
  ok(/changed from/.test((await page.getByTestId("section-mcp").textContent()) ?? ""), "AND THE STATUS SECTION SAYS THE ADDRESS CHANGED");
  ok(await canConnect(moved, token), "a client reaches the new address with the same token");
  eq(await quit(app), 0, "Quit, exit code 0");
  await new Promise<void>((resolve) => held!.close(() => resolve()));
  held = undefined;

  // =========================================================================
  // 7. The app log
  // =========================================================================

  ok(await until(() => /Costingly stopped/.test(readFileSync(APP_LOG, "utf8")), 10_000), "the app log is complete");
  const log = readFileSync(APP_LOG, "utf8");
  ok(/MCP endpoint is listening on port \d+/.test(log), "THE LOG SAYS THE ENDPOINT STARTED, with its port");
  ok(/moved from port \d+ to \d+/.test(log), "and that it moved");
  ok(/refused a request to \/mcp: the token was wrong/.test(log), "and that a wrong token was refused");
  ok(/mcp: query answered/.test(log) && /mcp: check_costingly answered/.test(log) && /mcp: describe_database answered/.test(log), "and each tool call, by name");
  ok(/mcp: query answered with an error/.test(log), "including the one that was an error");
  ok(!log.includes(token), "THE TOKEN IS NOWHERE IN THE LOG");
  ok(!log.includes("one_marker_column"), "AND NEITHER IS THE TEXT OF ANY QUERY");
  ok(!log.includes(SECRET), "nor the Plaid secret");
} finally {
  if (held !== undefined) await new Promise<void>((resolve) => held!.close(() => resolve()));
  await wipe();
}

checks.finish();
