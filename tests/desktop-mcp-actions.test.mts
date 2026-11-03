/**
 * The action tools, driven through a real MCP client against the running app,
 * with the window watched for what the tools do.
 *
 *   1. Ten tools, through the address and token the app wrote down
 *   2. sync from a client: the Accounts screen shows the run; sync_status
 *      reports it
 *   3. link_bank: the page's address is on the app's own server, and the page
 *      is served there
 *   4. unlink_bank, two steps: the bank leaves the Accounts screen
 *   5. The database stopped from Status: query explains; restart_database
 *      brings Running back on Status
 *   6. The app log: a line per call, no token, and no separate page server
 *   7. Relaunched: sync_status remembers nothing from before
 *
 * The banks are the seed generator's invented ones, put in the database
 * directly, as tests/desktop-accounts.test.mts does: Plaid is not available
 * to a test, and sample banks have nothing at Plaid to end, which is what lets
 * an unlink go through.
 *
 * Windows-only, like the app. Skips elsewhere.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";

import { buildDesktop, createChecks, expectHeadline, expectVisible, launch, quit, skipUnlessWindows, until } from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-mcp-actions-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { generateSeedDataset } = await import("../src/domain/services/seed/seed.generator.js");
const { applySeed } = await import("../src/domain/services/seed/seed.service.js");
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
const SECRET = "placeholder-secret-value-xyz";

/** What a tool said, read loosely: callTool's return type is a union. */
const text = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? "";

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

async function goToAccounts(page: Page): Promise<void> {
  await page.getByTestId("nav-accounts").click();
  await page.locator("[data-testid='accounts-screen'][data-state='ready']").waitFor({ timeout: 15_000 });
}

/** The endpoint as the app wrote it down for clients. */
function connection(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(DESKTOP, "mcp.json"), "utf8")) as { port: number; token: string };
}

async function connect(): Promise<InstanceType<typeof Client>> {
  const { port, token } = connection();
  const client = new Client({ name: "actions-suite", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

await writeConfig({ plaidClientId: "placeholder-client-id", plaidSecret: SECRET, encryptionKey: generateEncryptionKey() });
await install();
const dataset = generateSeedDataset({ seed: 11, years: 1, endDate: "2026-08-09" });
await applySeed(dataset);
await closeDb();
await server.stop();
ok(dataset.items.length >= 2, `sample banks to act on: ${dataset.items.length}`);

try {
  const { app, page } = await open();
  await goToAccounts(page);
  eq(await page.getByTestId("bank").count(), dataset.items.length, "the Accounts screen lists the sample banks");

  // =========================================================================
  // 1. Ten tools
  // =========================================================================
  const client = await connect();
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  eq((await client.listTools()).tools.length, 10, "A CLIENT IS OFFERED TEN TOOLS");

  // =========================================================================
  // 2. sync from a client, seen on the Accounts screen
  // =========================================================================
  ok(/No sync has run/.test(text(await call("sync_status"))), "sync_status before anything: nothing yet");
  const synced = await call("sync");
  eq(synced.isError, false, "sync from a client answers; sample banks are not synced, so it is quick");
  ok(/nothing to sync/.test(text(synced)), "and says there was nothing to sync");
  await expectVisible(checks, page.locator("[data-testid='accounts-screen'][data-sync='finished']"), "AND THE ACCOUNTS SCREEN SAW THE RUN, as if Sync had been pressed");
  await expectVisible(checks, page.getByTestId("sync-summary"), "and shows its result");
  ok(/started through this endpoint/.test(text(await call("sync_status"))), "sync_status reports the run, and that a client started it");

  // =========================================================================
  // 3. link_bank: the page on the app's own server
  // =========================================================================
  const link = await call("link_bank");
  eq(link.isError, undefined, "link_bank answers (placeholder keys count as present)");
  const { port } = connection();
  const pageAddress = `http://127.0.0.1:${port}/pages/link`;
  ok(text(link).includes(pageAddress), `THE ADDRESS IS THE APP'S OWN SERVER: ${pageAddress}`);
  const served = await fetch(pageAddress);
  ok(served.ok && /Plaid/.test(await served.text()), "and the page is really served there");

  // =========================================================================
  // 4. unlink_bank, two steps
  // =========================================================================
  const victim = dataset.items[0]!;
  const preview = await call("unlink_bank", { item_id: victim.itemId });
  ok(preview.isError === undefined && /NOTHING HAS BEEN DELETED YET/.test(text(preview)), "the first call previews and deletes nothing");
  eq(await page.getByTestId("bank").count(), dataset.items.length, "the Accounts screen still shows every bank");
  const token = /confirmation_token:\s*(\S+)/.exec(text(preview))?.[1] ?? "";
  const gone = await call("unlink_bank", { item_id: victim.itemId, confirmation_token: token });
  ok(gone.isError === undefined && /Disconnected/.test(text(gone)), "the second call, with the token, unlinks");
  await page.getByTestId("nav-status").click();
  await goToAccounts(page);
  eq(await page.getByTestId("bank").count(), dataset.items.length - 1, "AND THE BANK IS GONE FROM THE ACCOUNTS SCREEN");

  // =========================================================================
  // 5. The database stopped, and brought back by a tool
  // =========================================================================
  await page.getByTestId("nav-status").click();
  await page.getByTestId("database-action-stop").click();
  await expectHeadline(checks, page, "database", /^Stopped$/, "the database is stopped from Status");
  const stopped = await call("query", { sql: "SELECT 1" });
  ok(stopped.isError === true && /not running/.test(text(stopped)) && /restart_database/.test(text(stopped)), "a query is explained, naming restart_database");
  const revived = await call("restart_database");
  ok(revived.isError === undefined && /Running/.test(text(revived)), "restart_database brings it back");
  await page.getByTestId("nav-accounts").click();
  await page.getByTestId("nav-status").click();
  await expectHeadline(checks, page, "database", /^Running$/, "AND THE STATUS SCREEN SHOWS RUNNING AGAIN");

  await client.close();
  eq(await quit(app), 0, "Quit, exit code 0");

  // =========================================================================
  // 6. The app log
  // =========================================================================
  ok(await until(() => /Costingly stopped/.test(readFileSync(APP_LOG, "utf8")), 10_000), "the app log is complete");
  const log = readFileSync(APP_LOG, "utf8");
  for (const name of ["sync", "sync_status", "link_bank", "unlink_bank", "restart_database"]) {
    ok(new RegExp(`mcp: ${name} answered`).test(log), `the log has a line for ${name}`);
  }
  ok(/mcp: query answered with an error/.test(log), "a refused call is logged as answered with an error");
  ok(/sync started \(mcp\)/.test(log), "and says the sync was a model's");
  ok(!log.includes(connection().token), "THE TOKEN IS NOWHERE IN THE LOG");
  ok(!log.includes(SECRET), "nor the Plaid secret");
  ok(!/\[link\] listening/.test(log), "AND NO SEPARATE PAGE SERVER WAS STARTED — the page is a route on the app's own server");

  // =========================================================================
  // 7. Relaunched: sync_status remembers nothing from before
  // =========================================================================
  {
    const { app: relaunched } = await open();
    const again = await connect();
    ok(
      /No sync has run since Costingly started/.test(text(await again.callTool({ name: "sync_status", arguments: {} }))),
      "AFTER A RELAUNCH, sync_status says no sync has run since the app started — the memory is the app's, not the disk's",
    );
    await again.close();
    eq(await quit(relaunched), 0, "Quit, exit code 0");
  }
} finally {
  await wipe();
}

checks.finish();
