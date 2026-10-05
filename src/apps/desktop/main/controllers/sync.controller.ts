/**
 * The sync's two calls: start one, and say how it stands.
 *
 * Neither waits for a sync. Starting answers with "running" and returns; the
 * end is announced to the window by the application, as an event, whoever
 * started the run.
 */

import { presentSync } from "../presenters/sync.presenter.js";
import type { SyncService } from "../services/sync.service.js";
import type { Controller, HandlersFor } from "./controller.js";

export class SyncController implements Controller<"sync"> {
  constructor(private readonly sync: SyncService) {}

  handlers(): HandlersFor<"sync"> {
    return {
      "sync.start": async () => presentSync(this.sync.start("manual")),
      "sync.state": async () => presentSync(this.sync.state()),
    };
  }
}
