/**
 * Costingly's desktop app — the executable Electron runs.
 *
 * Launches the desktop application through the same host as the CLI and the
 * MCP server, then ends the Electron process with whatever exit code the host
 * settled on. What the app is made of is desktop.application.ts; how a process
 * is run is the host's; this file only joins the two to Electron.
 *
 * NOT awaited at top level, deliberately. Electron does not emit `ready` until
 * the entry module has finished evaluating, and the application's `start()`
 * waits for `ready` — so awaiting the launch here would wait on an event that
 * is waiting on this file. Letting the module finish and continuing in `then`
 * is correct whichever way a given Electron version orders the two.
 */

import { app } from "electron";

import { ApplicationHost } from "../../../platform/runtime/application-host.js";
import { DesktopApplication } from "./desktop.application.js";

void ApplicationHost.launch(new DesktopApplication(), {
  reportError: (error) => ({
    message: `[costingly desktop] fatal: ${error instanceof Error ? error.message : String(error)}`,
    exitCode: 1,
  }),
}).then(() => {
  // `exit`, not `quit`: quit re-enters before-quit, which the application
  // intercepts. By now every phase has run and there is nothing left to unwind.
  app.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
});
