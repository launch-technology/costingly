/**
 * The MCP endpoint's wording — a short table.
 *
 * Two readers of the same state: the Status screen's section and the Connect
 * screen. Each state is a row; what is checked is the headline, the tone, that
 * a failure carries a cause and a next step, that an address reads the way a
 * client needs it, and that none of it is command-line wording.
 */

import {
  addressOf,
  copyFailed,
  noTokenYet,
  presentConnect,
  presentMcpSection,
} from "../src/apps/desktop/main/features/connect/connect.presenter.js";

type LocalServerState = import("../src/apps/desktop/main/features/connect/local-server.service.js").LocalServerState;

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

const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed|doctor)\b|`|Claude Desktop/;
const everyWord = (view: object): string => JSON.stringify(view);

eq(addressOf(54400), "http://127.0.0.1:54400/mcp", "an address is the loopback host, the port and the one path");

// --- running ---------------------------------------------------------------
{
  const state: LocalServerState = { state: "running", port: 54400 };
  const section = presentMcpSection(state);
  eq([section.tone, section.headline, section.canRetry], ["good", "Running", false], "running: good, Running, nothing to retry");
  ok(section.details.some((line) => line.includes("http://127.0.0.1:54400/mcp")), "the section names the address");
  eq(section.problem, undefined, "and has no problem");

  const view = presentConnect(state);
  eq(view, { state: "running", address: "http://127.0.0.1:54400/mcp", canRetry: false }, "the Connect view: the address, no notice, no retry");
}

// --- running, but the address moved ----------------------------------------
{
  const state: LocalServerState = { state: "running", port: 54401, movedFrom: 54400 };
  const section = presentMcpSection(state);
  eq([section.tone, section.headline], ["warn", "Running"], "MOVED: still Running, but worth a look");
  ok(section.details.some((line) => /changed from http:\/\/127\.0\.0\.1:54400\/mcp/.test(line)), "the section says where it moved from");
  ok(section.details.some((line) => /configured by hand/.test(line)), "and who is affected");

  const view = presentConnect(state);
  eq([view.address, view.movedFrom], ["http://127.0.0.1:54401/mcp", "http://127.0.0.1:54400/mcp"], "the Connect view carries both addresses");
}

// --- stopped ---------------------------------------------------------------
{
  const section = presentMcpSection({ state: "stopped", port: 54400 });
  eq([section.tone, section.headline, section.canRetry], ["neutral", "Not running", true], "stopped: neutral, Not running, Try again offered");
  const view = presentConnect({ state: "stopped" });
  eq([view.state, view.address, view.canRetry], ["stopped", "", true], "stopped with no port yet: an empty address, for the screen to word");
}

// --- failed ----------------------------------------------------------------
{
  const noPort = presentMcpSection({
    state: "failed",
    kind: "no-port",
    reason: 'Could not find a free port for "mcp" on 127.0.0.1. Tried 54400 through 54419.',
  });
  eq([noPort.tone, noPort.headline, noPort.canRetry], ["bad", "Could not start", true], "NO FREE PORT: bad, Could not start, Try again offered");
  ok(noPort.problem !== undefined && /no free port/i.test(noPort.problem.cause), "the cause says no port was free");
  ok(noPort.problem !== undefined && /54400 through 54419/.test(noPort.problem.cause), "and carries the range that was tried");
  ok(noPort.problem !== undefined && /Try again/.test(noPort.problem.nextStep) && /Restarting your computer/.test(noPort.problem.nextStep), "the next step is to free a port and try again");

  const listen = presentConnect({ state: "failed", port: 54400, kind: "listen", reason: "listen EACCES: permission denied" });
  eq([listen.state, listen.address, listen.canRetry], ["failed", "http://127.0.0.1:54400/mcp", true], "LISTEN FAILED: the address it tried is still shown");
  ok(listen.problem !== undefined && /permission denied/.test(listen.problem.cause), "with the reason");
  ok(listen.problem !== undefined && /Logs screen/.test(listen.problem.nextStep), "pointing at the app log");

  const token = presentMcpSection({ state: "failed", kind: "token", reason: "the token could not be read or saved: EACCES" });
  ok(token.problem !== undefined && /written to/.test(token.problem.nextStep), "A TOKEN THAT CANNOT BE SAVED points at the app's folder");

  for (const view of [noPort, listen, token]) {
    ok(view.problem !== undefined && view.problem.cause.trim() !== "" && view.problem.nextStep.trim() !== "", "every failure has both halves");
  }
}

// --- the small ones --------------------------------------------------------
{
  const copy = copyFailed("The token", "the clipboard is not available");
  ok(/The token could not be copied: the clipboard is not available/.test(copy.cause) && /by hand/.test(copy.nextStep), "a failed copy says what and offers the hand route");
  const none = noTokenYet();
  ok(/no token yet/.test(none.cause) && /Try again/.test(none.nextStep), "asking for a token before there is one says so");
}

// --- none of it is CLI wording -----------------------------------------------
{
  const states: LocalServerState[] = [
    { state: "running", port: 54400 },
    { state: "running", port: 54401, movedFrom: 54400 },
    { state: "stopped" },
    { state: "failed", kind: "no-port", reason: "none free" },
    { state: "failed", kind: "listen", port: 54400, reason: "EACCES" },
    { state: "failed", kind: "token", reason: "EACCES" },
  ];
  ok(
    states.every((state) => !CLI_WORDING.test(everyWord(presentMcpSection(state))) && !CLI_WORDING.test(everyWord(presentConnect(state)))),
    "NO STATE IS WORDED FOR A TERMINAL OR FOR CLAUDE DESKTOP",
  );
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
