/**
 * The Connect screen's calls: how the endpoint stands, try again, show the
 * token, copy the address or the token.
 *
 * THE TOKEN CROSSES TO THE WINDOW ONLY ON REQUEST. `connect.read` never
 * carries it; `connect.showToken` does, when the user presses Show. Copying
 * happens here, in the main process, so a copy never sends it to the window
 * at all. The clipboard function is Electron's, handed in by the application
 * as it is to the logs controller.
 */

import type { CopyOutcome, ShowTokenResult } from "../../../bridge/contract.js";
import type { Controller, HandlersFor } from "../../shared/controller.js";
import { addressOf, copyFailed, noTokenYet, presentConnect } from "./connect.presenter.js";
import type { LocalServerService } from "./local-server.service.js";

export class ConnectController implements Controller<"connect"> {
  constructor(
    private readonly server: LocalServerService,
    /** Puts text on the clipboard. Electron's, handed in. */
    private readonly copyToClipboard: (text: string) => void,
    /** A safe one-line description of any error — never the error object. */
    private readonly describeError: (error: unknown) => string,
  ) {}

  handlers(): HandlersFor<"connect"> {
    return {
      "connect.read": async () => presentConnect(this.server.state()),
      "connect.retry": async () => presentConnect(await this.server.retry()),

      "connect.showToken": async (): Promise<ShowTokenResult> => {
        const token = this.server.token();
        return token === undefined ? { outcome: "failed", problem: noTokenYet() } : { outcome: "shown", token };
      },

      "connect.copyAddress": async () =>
        this.copy("The address", () => {
          const { port } = this.server.state();
          if (port === undefined) throw new Error("there is no address yet");
          return addressOf(port);
        }),

      "connect.copyToken": async () =>
        this.copy("The token", () => {
          const token = this.server.token();
          if (token === undefined) throw new Error("there is no token yet");
          return token;
        }),
    };
  }

  private copy(what: string, text: () => string): CopyOutcome {
    try {
      this.copyToClipboard(text());
      return { outcome: "copied" };
    } catch (error) {
      return { outcome: "failed", problem: copyFailed(what, this.describeError(error)) };
    }
  }
}
