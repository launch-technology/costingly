/**
 * The Claude Desktop screen's wording, and what the app remembers about the
 * extension — a short table, plain node, every platform.
 *
 *   1. ExtensionPresenceService   only the extension counts; the latest wins;
 *                                 nothing before the first request
 *   2. presentClaudeDesktop       the file found or missing; never heard,
 *                                 heard and compatible, heard with a different
 *                                 major; the two problems
 *   3. locateExtension            a real folder: the file at the app's version
 *                                 is preferred, the newest otherwise, a missing
 *                                 or absent folder is simply missing
 *   4. The shared version rule    platform/version.ts, as the extension and
 *                                 the app both read it
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_COMMAND, extensionFolder, locateExtension } from "../src/apps/desktop/main/features/claude-desktop/claude-desktop.adapter.js";
import { nothingToOpen, openFailed, presentClaudeDesktop } from "../src/apps/desktop/main/features/claude-desktop/claude-desktop.presenter.js";
import { EXTENSION_CLIENT_NAME, ExtensionPresenceService } from "../src/apps/desktop/main/features/claude-desktop/extension-presence.service.js";
import { compatible, majorOf } from "../src/platform/version.js";

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

const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed|doctor)\b/;
const T0 = new Date("2026-11-14T14:32:00.000Z");
const T1 = new Date("2026-11-14T14:40:00.000Z");

// ===========================================================================
// 1. ExtensionPresenceService
// ===========================================================================
{
  const presence = new ExtensionPresenceService();
  eq(presence.lastSeen(), undefined, "NOTHING HAS BEEN HEARD before the first request");

  presence.record("mcp-inspector/0.17.0", T0);
  eq(presence.lastSeen(), undefined, "another client naming itself is not the extension and is not recorded");

  presence.record(`${EXTENSION_CLIENT_NAME}/2.0.0`, T0);
  eq(presence.lastSeen(), { version: "2.0.0", at: T0 }, "THE EXTENSION'S REQUEST IS RECORDED with its version and time");

  presence.record(`${EXTENSION_CLIENT_NAME}/2.1.0`, T1);
  eq(presence.lastSeen(), { version: "2.1.0", at: T1 }, "the latest request wins");

  presence.record("costingly-mcpb", T1);
  presence.record("/2.0.0", T1);
  presence.record("costingly-mcpb/", T1);
  eq(presence.lastSeen(), { version: "2.1.0", at: T1 }, "a header without both halves changes nothing");

  presence.record("costingly-mcpb/3.0.0-beta/1", T1);
  eq(presence.lastSeen()?.version, "2.1.0", "split at the LAST slash: a name with a slash in it is not the extension's");
  eq(EXTENSION_CLIENT_NAME, "costingly-mcpb", "the name the service listens for is the one apps/mcpb/main.ts sends");
}

// ===========================================================================
// 2. presentClaudeDesktop
// ===========================================================================
{
  const found = { state: "found" as const, path: "C:\\apps\\resources\\extension\\costingly-2.0.0.mcpb", version: "2.0.0" };
  const missing = { state: "missing" as const, folder: "C:\\repo\\build", buildCommand: BUILD_COMMAND };

  const never = presentClaudeDesktop(found, undefined, "2.0.0");
  eq(never, { appVersion: "2.0.0", file: found, connection: { state: "never" } }, "NEVER HEARD: the file, the app's version, and no connection");

  const heard = presentClaudeDesktop(found, { version: "2.0.0", at: T0 }, "2.0.0");
  eq(heard.connection, { state: "heard", at: T0.toISOString(), version: "2.0.0", compatible: true }, "HEARD: when, the extension's version, compatible");

  const minor = presentClaudeDesktop(found, { version: "2.0.0", at: T0 }, "2.3.1");
  eq(minor.connection.state === "heard" && minor.connection.compatible, true, "a different MINOR version is still compatible: information only");

  const major = presentClaudeDesktop(found, { version: "1.5.0", at: T0 }, "2.0.0");
  eq(major.connection, { state: "heard", at: T0.toISOString(), version: "1.5.0", compatible: false }, "A DIFFERENT MAJOR VERSION IS FLAGGED, with both versions in the view");

  const none = presentClaudeDesktop(missing, undefined, "2.0.0");
  eq(none.file, missing, "RUN FROM SOURCE WITHOUT THE FILE: the folder looked in and the command that makes it");

  const open = openFailed(found.path, "Explorer refused");
  ok(/could not be opened: Explorer refused/.test(open.cause) && open.nextStep.includes(found.path), "a folder that could not be opened names the reason and the full path for the hand route");
  const nothing = nothingToOpen(missing.folder, missing.buildCommand);
  ok(nothing.cause.includes(missing.folder) && nothing.nextStep.includes("npm run build:bundle"), "Open folder with no file says where it looked and what to run");

  for (const view of [never, heard, minor, major, none]) {
    ok(!CLI_WORDING.test(JSON.stringify(view)), "no view is worded for a terminal");
  }
}

// ===========================================================================
// 3. locateExtension, over a real folder
// ===========================================================================
{
  const dir = mkdtempSync(join(tmpdir(), "costingly-extension-"));
  try {
    eq(locateExtension(dir, "2.0.0"), { state: "missing", folder: dir, buildCommand: "npm run build:bundle" }, "AN EMPTY FOLDER: missing, naming the folder and the build command");
    eq(locateExtension(join(dir, "not-there"), "2.0.0").state, "missing", "a folder that does not exist is simply missing, not an error");

    writeFileSync(join(dir, "costingly-2.0.0.mcpb"), "zip");
    writeFileSync(join(dir, "costingly-2.1.0.mcpb"), "zip");
    writeFileSync(join(dir, "costingly-10.0.0.mcpb"), "zip");
    writeFileSync(join(dir, "costingly-2.0.0.mcpb.bak"), "not it");
    writeFileSync(join(dir, "other-2.0.0.mcpb"), "not it");
    mkdirSync(join(dir, "installer"));

    eq(locateExtension(dir, "2.1.0"), { state: "found", path: join(dir, "costingly-2.1.0.mcpb"), version: "2.1.0" }, "THE FILE AT THE APP'S VERSION IS PREFERRED when several are there");
    eq(locateExtension(dir, "3.0.0"), { state: "found", path: join(dir, "costingly-10.0.0.mcpb"), version: "10.0.0" }, "otherwise the newest by version, counting numerically (10 after 2)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const packaged = extensionFolder(true, "C:\\Program Files\\Costingly\\resources");
  eq(packaged, join("C:\\Program Files\\Costingly\\resources", "extension"), "PACKAGED: resources/extension, where the installer puts it");
  ok(/[\\/]build$/.test(extensionFolder(false, "ignored")), "FROM SOURCE: the repository's build/, where build:bundle writes");
}

// ===========================================================================
// 4. The shared version rule
// ===========================================================================
{
  eq([majorOf("2.0.0"), majorOf("10.3.1-beta"), majorOf("nonsense"), majorOf("")], [2, 10, undefined, undefined], "majorOf reads the leading number or nothing");
  ok(compatible("2.0.0", "2.9.9") && compatible("2.0.0", "2.0.0"), "the same major is compatible");
  ok(!compatible("1.9.9", "2.0.0") && !compatible("3.0.0", "2.0.0"), "a different major is not");
  ok(compatible(undefined, "2.0.0") && compatible("dev", "2.0.0") && compatible("2.0.0", "dev"), "a version that cannot be read is not a reason to refuse");
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
