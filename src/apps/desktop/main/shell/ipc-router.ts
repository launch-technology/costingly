/**
 * Connects the contract's calls to the handlers that answer them.
 *
 * The one place `ipcMain` is touched. It is handed a complete set of handlers
 * — the type requires one for every call in the contract — and registers each
 * under the call's own name, so there is no second list of channel names to
 * keep in step with the first.
 *
 * ONLY THE APP'S OWN WINDOW MAY CALL. Every call is checked against who sent
 * it, and anything that is not the top page of the main window is refused and
 * logged. The app has one window today and it runs only our bundled code, so
 * this refuses nothing in practice — it is what keeps that true if a second
 * window, or a frame inside the first, ever appears.
 *
 * FAILURES ARE HANDLED ONCE, HERE. A handler that throws is logged on this
 * side and the window is given a plain message built by `describe`, never the
 * thrown object. That matters beyond tidiness: an error from the Plaid SDK
 * carries the request it belonged to, and the request carries the secret.
 * Handlers that have a failure to REPORT return it as a value in their result
 * type; what reaches here is only what nobody expected.
 */

import { ipcMain, type WebContents } from "electron";

import type { AllHandlers } from "../controllers/controller.js";

export interface IpcRouterOptions {
  /** Is this page the app's own window? Asked for every call, when it arrives. */
  isAppWindow(sender: WebContents): boolean;
  /** A safe one-line description of any error. */
  describe(error: unknown): string;
  log(line: string): void;
}

export function registerHandlers(handlers: AllHandlers, options: IpcRouterOptions): void {
  for (const [call, handler] of Object.entries(handlers)) {
    const answer = handler as (...args: unknown[]) => Promise<unknown>;

    ipcMain.handle(call, async (event, ...args: unknown[]) => {
      // The top page of the window only: a frame inside it is somebody else's.
      if (event.senderFrame !== event.sender.mainFrame || !options.isAppWindow(event.sender)) {
        options.log(`${call} refused: it did not come from the app's window`);
        throw new Error("That is not available from here.");
      }

      try {
        return await answer(...args);
      } catch (error) {
        const reason = options.describe(error);
        options.log(`${call} failed: ${reason}`);
        throw new Error(reason);
      }
    });
  }
}
