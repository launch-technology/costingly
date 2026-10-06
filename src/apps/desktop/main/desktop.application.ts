/**
 * costingly as a desktop application.
 *
 * The third interface, beside the CLI and the MCP server, and the first that
 * stays up: `start()` claims the single-instance lock and builds everything,
 * `run()` waits until Quit is chosen, `stop()` releases. Nothing here calls
 * `app.exit()` — that is main.ts's job once the host has run all three
 * phases, which is what guarantees the database is stopped before the
 * process goes.
 *
 * THIS IS THE COMPOSITION ROOT, AND ONLY THAT
 *
 * Every object the app is made of is constructed in `compose()` and handed
 * what it depends on; nothing below reaches for a collaborator on its own.
 * So this file answers "what is the app made of, and what talks to what", and
 * the behaviour lives in the pieces:
 *
 *   controllers/   answer the window's calls, one class per feature
 *   services/      what the app does; no Electron
 *   adapters/      the real domain, fitted to what the services ask for
 *   presenters/    domain reports, worded for a screen
 *   shell/         the Electron objects: window, tray, the IPC router
 *
 * A new feature is a controller added to the list in `compose()` and its
 * calls added to the contract. The compiler refuses a contract call that no
 * controller answers.
 *
 * WHY QUIT IS INTERCEPTED
 *
 * Electron's own `app.quit()` tears the process down on its own schedule, and
 * it is reachable from places this file does not control — a session logoff,
 * a test harness, a future menu. Every one of those goes through `before-quit`,
 * so that is where it is caught, turned into "run() is finished", and left for
 * the host to unwind in order. One exit path, however the quit was asked for.
 *
 * WHY THERE IS NO SECOND COPY
 *
 * `requestSingleInstanceLock()` fails in the second copy, which then finishes
 * `run()` immediately and exits having built nothing. The first copy is told
 * and brings its window forward. Because the second copy returns before
 * anything is composed, it can never stop a database the first copy is using.
 */

import { app, shell } from "electron";

import type { Application } from "../../../platform/runtime/application.js";
import { ResourceScope } from "../../../platform/runtime/resource-scope.js";
import * as domain from "./adapters/domain.js";
import { AccountsController } from "./controllers/accounts.controller.js";
import type { AllHandlers } from "./controllers/controller.js";
import { DatabaseController, databaseSectionReader } from "./controllers/database.controller.js";
import { LinkController } from "./controllers/link.controller.js";
import { SetupController } from "./controllers/setup.controller.js";
import { StatusController } from "./controllers/status.controller.js";
import { SyncController } from "./controllers/sync.controller.js";
import { TransactionsController } from "./controllers/transactions.controller.js";
import { desktopDir, desktopSettingsPath } from "./desktop-paths.js";
import { explainDatabaseFailure } from "./presenters/database.presenter.js";
import { presentSync } from "./presenters/sync.presenter.js";
import { AccountsService } from "./services/accounts.service.js";
import { CloseNoticeService } from "./services/close-notice.service.js";
import { DatabaseService } from "./services/database.service.js";
import { SettingsService } from "./services/settings.service.js";
import { SetupService } from "./services/setup.service.js";
import { SyncService } from "./services/sync.service.js";
import { TransactionsService } from "./services/transactions.service.js";
import { UnlinkService } from "./services/unlink.service.js";
import { registerHandlers } from "./shell/ipc-router.js";
import { MainWindow } from "./shell/main-window.js";
import { placeholderIcon } from "./shell/placeholder-icon.js";
import { TrayIcon } from "./shell/tray-icon.js";

export class DesktopApplication implements Application {
  readonly name = "costingly desktop";

  private readonly scope = new ResourceScope();
  private window: MainWindow | undefined;

  private secondCopy = false;
  private resolveQuit: (() => void) | undefined;
  private readonly quitRequested = new Promise<void>((resolve) => {
    this.resolveQuit = resolve;
  });

  async start(): Promise<void> {
    // Before anything else, and before `ready`: Electron decides where its
    // cache and session live from this, and the default is %APPDATA%\costingly
    // — a second place on the machine for the uninstaller to know about.
    app.setPath("userData", desktopDir(domain.profile));

    if (!app.requestSingleInstanceLock()) {
      this.secondCopy = true;
      return;
    }

    app.on("second-instance", () => this.window?.reveal());
    // Windows are hidden, never closed, so this never fires — but Electron's
    // default handler quits the app, and a future window that IS closed must
    // not take the tray with it.
    app.on("window-all-closed", () => {});
    app.on("before-quit", (event) => {
      event.preventDefault();
      this.requestQuit();
    });

    await this.compose();
  }

  /** Stay running until Quit. The second copy has nothing to wait for. */
  async run(): Promise<void> {
    if (this.secondCopy) return;
    await this.quitRequested;
  }

  async stop(): Promise<void> {
    this.window?.allowClose();
    await this.scope.closeAll();
  }

  /**
   * Build the app. Every `new` in the desktop app is here.
   *
   * Release order is the reverse of registration: the window and tray go
   * first, and the database last — its service closes this process's
   * connections and then stops the server, after whatever it was already doing.
   */
  private async compose(): Promise<void> {
    const log = (line: string): void => console.error(`[${this.name}] ${line}`);

    // --- the database, brought up while Electron is still getting ready ------
    // The two waits overlap, and the first status check the window makes then
    // finds the database already up instead of reporting a stop about to end.
    const database = new DatabaseService(domain.databaseDependencies(log));
    const databaseComingUp = database.bringUp();
    this.scope.onClose("database", () => database.stop());

    await app.whenReady();

    // --- what the window can ask for ----------------------------------------
    const databaseSection = databaseSectionReader(domain.databaseSources, database);

    const setup = new SetupService({
      ...domain.setupDependencies(),
      // Setup creates the database through the same service, and explains a
      // failure in the same words, as the status screen's own button.
      createDatabase: async () => {
        const failure = await database.create();
        return failure === undefined ? undefined : explainDatabaseFailure(failure).problem;
      },
    });

    const icon = placeholderIcon();

    // --- linking a bank, in the user's browser --------------------------------
    // The local link page is started when asked for and stops itself when idle;
    // this is so Quit never leaves it listening. Registered after the database,
    // so released before it: the page stops while there is still a database
    // for anything it was saving.
    this.scope.onClose("link page", async () => void (await domain.linkPage.stop()));

    // --- the sync, in the background -------------------------------------------
    // Started by the Sync button today; anything else that starts one later —
    // a schedule — calls the same `start()`, and the window hears about it the
    // same way. Quit does not wait for a run in flight: it silences the service
    // and lets the database stop, which fails whatever the run does next. No
    // query can start the database again, and the run's progress is committed
    // bank by bank, so nothing is lost and nothing is left running.
    const sync = new SyncService({
      ...domain.syncDependencies(),
      now: () => new Date(),
      onChange: (state) => this.window?.emit("sync.changed", presentSync(state)),
    });
    this.scope.onClose("sync", async () => sync.stop());

    const handlers: AllHandlers = {
      ...new StatusController(domain.statusChecks(), databaseSection).handlers(),
      ...new DatabaseController(database, databaseSection, domain.databaseLog).handlers(),
      ...new SetupController(setup, (url) => shell.openExternal(url)).handlers(),
      ...new AccountsController(
        new AccountsService(domain.accountsDependencies()),
        // An unlink takes exclusive use from the sync: the two never overlap.
        new UnlinkService({ ...domain.unlinkDependencies(), exclusively: (work) => sync.runExclusive(work) }),
      ).handlers(),
      ...new LinkController(
        async () => shell.openExternal((await domain.linkPage.start()).url),
        async (bankId) => shell.openExternal(await domain.linkPage.startForReconnect(bankId)),
      ).handlers(),
      ...new SyncController(sync).handlers(),
      ...new TransactionsController(
        new TransactionsService(domain.transactionsDependencies()),
        domain.transactionsPageSize,
      ).handlers(),
    };
    registerHandlers(handlers, {
      isAppWindow: (sender) => this.window?.owns(sender) ?? false,
      describe: domain.describeError,
      log,
    });

    // --- the tray, and the notice it shows once ------------------------------
    const tray = new TrayIcon({
      icon,
      onOpen: () => this.window?.reveal(),
      onQuit: () => this.requestQuit(),
    });
    this.scope.onClose("tray", async () => tray.destroy());

    const closeNotice = new CloseNoticeService(
      new SettingsService(desktopSettingsPath(domain.profile)),
      () =>
        tray.notify(
          "Costingly is still running",
          "It lives in the system tray. Click the icon to reopen it, or choose Quit to stop.",
        ),
    );

    // --- the window ----------------------------------------------------------
    await databaseComingUp;
    const window = new MainWindow({
      icon,
      onHidden: () => void closeNotice.windowHidden(),
    });
    this.window = window;
    this.scope.onClose("window", async () => window.destroy());
    await window.open();
  }

  private requestQuit(): void {
    this.resolveQuit?.();
  }
}
