/**
 * The local server's state, worded twice: for the Status screen's MCP endpoint
 * section, and for the Connect screen. Pure functions, like the other
 * presenters; every state is a table entry in
 * tests/desktop-connect-presenter.test.mts.
 *
 * The address is assembled here and only here: the service knows a port, and
 * what a client types is this file's decision.
 */

import type { ConnectView, McpSectionView, Problem } from "../../../bridge/contract.js";
import type { LocalServerState } from "./local-server.service.js";

const HOST = "127.0.0.1";
const PATH = "/mcp";

/** What a client is given: "http://127.0.0.1:54400/mcp". */
export function addressOf(port: number): string {
  return `http://${HOST}:${port}${PATH}`;
}

export function presentMcpSection(state: LocalServerState): McpSectionView {
  switch (state.state) {
    case "running": {
      const moved = state.movedFrom === undefined ? [] : [movedLine(state.movedFrom)];
      return {
        tone: moved.length === 0 ? "good" : "warn",
        headline: "Running",
        details: [`Listening at ${addressOf(state.port)}`, ...moved, "The token is on the Connect screen."],
        canRetry: false,
      };
    }
    case "stopped":
      return {
        tone: "neutral",
        headline: "Not running",
        details: ["Local MCP clients cannot connect right now."],
        canRetry: true,
      };
    case "failed":
      return {
        tone: "bad",
        headline: "Could not start",
        details: [],
        problem: explainFailure(state),
        canRetry: true,
      };
  }
}

export function presentConnect(state: LocalServerState): ConnectView {
  const address = state.port === undefined ? "" : addressOf(state.port);
  switch (state.state) {
    case "running":
      return {
        state: "running",
        address,
        ...(state.movedFrom === undefined ? {} : { movedFrom: addressOf(state.movedFrom) }),
        canRetry: false,
      };
    case "stopped":
      return { state: "stopped", address, canRetry: true };
    case "failed":
      return { state: "failed", address, problem: explainFailure(state), canRetry: true };
  }
}

/** A copy that did not happen, worded for the screen. */
export function copyFailed(what: string, reason: string): Problem {
  return {
    cause: `${what} could not be copied: ${reason}`,
    nextStep: "Try again, or select it on this screen and copy it by hand.",
  };
}

/** Asked for the token before a start has read or made one. */
export function noTokenYet(): Problem {
  return {
    cause: "There is no token yet: the endpoint has not started.",
    nextStep: "Press Try again. If it keeps failing, the app log on the Logs screen says more.",
  };
}

function movedLine(from: number): string {
  return `The address changed from ${addressOf(from)}. Any client configured by hand needs the new one.`;
}

function explainFailure(state: Extract<LocalServerState, { state: "failed" }>): Problem {
  switch (state.kind) {
    case "no-port":
      return {
        cause: `The MCP endpoint could not start: no free port was found. ${state.reason}`,
        nextStep:
          "Close whatever is using those ports, then press Try again. Restarting your computer will free them.",
      };
    case "listen":
      return {
        cause: `The MCP endpoint could not start listening. ${state.reason}`,
        nextStep: "Press Try again. If it keeps failing, the app log on the Logs screen says more.",
      };
    case "token":
      return {
        cause: `The MCP endpoint could not start: ${state.reason}`,
        nextStep: "Check that the app's folder can be written to, then press Try again.",
      };
  }
}
