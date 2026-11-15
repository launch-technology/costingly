/**
 * The Claude Desktop screen, driven through the window with a real MCP client
 * standing in for the extension.
 *
 *   1. What it shows: the sidebar entry above Connect; not connected; the
 *      file in build/ named, Open folder enabled; the instructions
 *   2. Heard: a client naming itself as the extension connects and lists the
 *      tools, calling nothing — Refresh shows Connected with its version
 *   3. Mismatch: a client naming an older major version — the warning, with
 *      both versions
 *   4. Relaunched: not connected again (nothing is remembered)
 *   5. The file missing: build/ without it says so, names the command, and
 *      Open folder is disabled
 *
 * Open folder itself is not pressed here — it would open Explorer on the
 * machine running the suite. The controller is exercised over a fake shell in
 * desktop-services.test.mts.
 *
 * THE FILE IN build/ IS THE REAL ONE when it is there: the suite only reads
 * its name. For case 5 it is moved aside and put back. Windows-only, like the
 * app. Skips elsewhere.
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";

import { buildDesktop, createChecks, expectVisible, launch, quit, ROOT, skipUnlessWindows } from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-claude-desktop-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

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

const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const BUILD = join(ROOT, "build");
const FILE = join(BUILD, `costingly-${VERSION}.mcpb`);
const CONNECTION = join(DESKTOP, "mcp.json");

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

async function goToClaudeDesktop(page: Page): Promise<void> {
  await page.getByTestId("nav-claude-desktop").click();
  await page.locator("[data-testid='claude-desktop-screen']:not([data-state='loading'])").waitFor({ timeout: 15_000 });
}

/** Press Refresh and wait for the re-read to land: a view in `state`, or the same view again. */
async function refresh(page: Page, state: "never" | "heard"): Promise<void> {
  await page.getByTestId("claude-desktop-refresh").click();
  await page.locator(`[data-testid='claude-desktop-screen'][data-state='${state}']`).waitFor({ timeout: 15_000 }).catch(() => {});
}

const status = async (page: Page): Promise<string> => (await page.getByTestId("claude-desktop-status").textContent()) ?? "";

/** Connect as the extension would — its header, a handshake and a tool listing, no tool call. */
async function connectAs(client: string): Promise<void> {
  const { port, token } = JSON.parse(readFileSync(CONNECTION, "utf8")) as { port: number; token: string };
  const c = new Client({ name: "claude-desktop-suite", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Costingly-Client": client } },
    }),
  );
  await c.listTools();
  await c.close();
}

await writeConfig({
  plaidClientId: "placeholder-client-id",
  plaidSecret: "placeholder-secret-value-xyz",
  encryptionKey: generateEncryptionKey(),
});
await install();
await closeDb();
await server.stop();

// The file the screen points at. The real one when build:bundle has run;
// otherwise a stand-in with the right name, removed at the end.
await mkdir(BUILD, { recursive: true });
const placeholder = !existsSync(FILE);
if (placeholder) writeFileSync(FILE, "stand-in for the suite: the screen reads only the name");
/** Other extension files in build/ (a developer's older builds) moved aside for case 5. */
const held: Array<[string, string]> = [];

try {
  // =========================================================================
  // 1. What it shows
  // =========================================================================

  let { app, page } = await open();
  const entries = await page.getByRole("navigation", { name: "Screens" }).getByRole("button").allInnerTexts();
  eq(entries.indexOf("Claude Desktop"), entries.indexOf("Other clients") - 1, "THE SIDEBAR HAS CLAUDE DESKTOP, directly above Other clients");

  await goToClaudeDesktop(page);
  eq(await page.getByTestId("claude-desktop-screen").getAttribute("data-state"), "never", "the screen says Claude Desktop has not connected");
  ok(/Not connected/.test(await status(page)) && /restart Claude Desktop/.test(await status(page)), "in words, with the restart reminder");
  eq(await page.getByTestId("claude-desktop-file").textContent(), FILE, `THE FILE IS NAMED: ${FILE}`);
  eq(await page.getByTestId("claude-desktop-open-folder").isEnabled(), true, "and Open folder is enabled");
  const install_ = (await page.getByTestId("claude-desktop-install").textContent()) ?? "";
  ok(/drag the file into the Claude Desktop window/.test(install_) && /search them for .extension./.test(install_) && /Restart Claude Desktop/.test(install_), "the two ways in and the restart are on the screen");
  ok(!/→/.test(install_) && !/Extension Developer/.test(install_), "AND NO MENU PATH IS SPELLED OUT: Claude Desktop's settings move between versions");
  eq(await page.getByTestId("claude-desktop-mismatch").count(), 0, "no mismatch warning");

  // =========================================================================
  // 2. Heard
  // =========================================================================

  await connectAs(`costingly-mcpb/${VERSION}`);
  await refresh(page, "heard");
  eq(await page.getByTestId("claude-desktop-screen").getAttribute("data-state"), "heard", "AFTER THE EXTENSION CONNECTS AND LISTS THE TOOLS — NO TOOL CALLED — REFRESH SHOWS CONNECTED");
  const heard = await status(page);
  ok(/Connected/.test(heard) && heard.includes(`Extension ${VERSION}`) && heard.includes(`Costingly ${VERSION}`), "with the extension's version and the app's");
  ok(/\d{1,2}:\d{2}/.test(heard), "and the time it was last heard from");
  eq(await page.getByTestId("claude-desktop-mismatch").count(), 0, "same version: no warning");

  // =========================================================================
  // 3. Mismatch
  // =========================================================================

  await connectAs("costingly-mcpb/1.0.0");
  await refresh(page, "heard");
  await expectVisible(checks, page.getByTestId("claude-desktop-mismatch"), "AN OLDER MAJOR VERSION: THE WARNING IS SHOWN");
  const warning = (await page.getByTestId("claude-desktop-mismatch").textContent()) ?? "";
  ok(warning.includes("extension 1.0.0") && warning.includes(`Costingly is ${VERSION}`) && /Reinstall the extension/.test(warning), "naming both versions and saying to reinstall");

  // =========================================================================
  // 4. Relaunched
  // =========================================================================

  eq(await quit(app), 0, "Quit, exit code 0");
  ({ app, page } = await open());
  await goToClaudeDesktop(page);
  eq(await page.getByTestId("claude-desktop-screen").getAttribute("data-state"), "never", "RELAUNCHED: NOT CONNECTED AGAIN — nothing is remembered across a restart");
  eq(await quit(app), 0, "Quit, exit code 0");

  // =========================================================================
  // 5. The file missing
  // =========================================================================

  for (const name of readdirSync(BUILD)) {
    if (/^costingly-.*\.mcpb$/.test(name)) {
      const from = join(BUILD, name);
      const to = `${from}.held-by-suite`;
      renameSync(from, to);
      held.push([from, to]);
    }
  }
  ({ app, page } = await open());
  await goToClaudeDesktop(page);
  eq(await page.getByTestId("claude-desktop-screen").getAttribute("data-file"), "missing", "WITHOUT THE FILE IN build/: the screen says it is missing");
  const missing = (await page.getByTestId("claude-desktop-missing").textContent()) ?? "";
  ok(/npm run build:bundle/.test(missing) && missing.includes(BUILD), "names the command that builds it and the folder it looked in");
  eq(await page.getByTestId("claude-desktop-open-folder").isEnabled(), false, "and Open folder is disabled");
  eq(await quit(app), 0, "Quit, exit code 0");
} finally {
  for (const [from, to] of held) if (existsSync(to)) renameSync(to, from);
  if (placeholder && existsSync(FILE)) unlinkSync(FILE);
  await wipe();
}

checks.finish();
