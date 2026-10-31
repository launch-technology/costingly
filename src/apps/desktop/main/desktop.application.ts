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
 * The one exception is the log (platform/runtime/log.ts), which every layer
 * imports directly and `start()` points at the app's file: handing a logger
 * to every constructor would say nothing about any of them.
 * So this file answers "what is the app made of, and what talks to what", and
 * the behaviour lives in the pieces:
 *
 *   features/      one folder per thing the app does, with its controller
 *                  (answers the window's calls), service (what the app does;
 *                  no Electron), presenter (domain reports, worded for a
 *                  screen) and adapter (the real domain, fitted to what the
 *                  service asks for) side by side
 *   shared/        what more than one feature uses
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

import { app, clipboard, shell } from "electron";

import type { Application } from "../../../platform/runtime/application.js";
import { configureLog, log } from "../../../platform/runtime/log.js";
import { ResourceScope } from "../../../platform/runtime/resource-scope.js";
import { desktopDir, desktopLogPath, desktopStatePath } from "./desktop-paths.js";
import { accountsDependencies, linkPage, unlinkDependencies } from "./features/accounts/accounts.adapter.js";
import { AccountsController } from "./features/accounts/accounts.controller.js";
import { AccountsService } from "./features/accounts/accounts.service.js";
import { LinkController } from "./features/accounts/link.controller.js";
import { UnlinkService } from "./features/accounts/unlink.service.js";
import { databaseDependencies, databaseSources } from "./features/database/database.adapter.js";
import { DatabaseController, databaseSectionReader } from "./features/database/database.controller.js";
import { explainDatabaseFailure } from "./features/database/database.presenter.js";
import { DatabaseService } from "./features/database/database.service.js";
import { reportDependencies } from "./features/logs/logs.adapter.js";
import { LogsController } from "./features/logs/logs.controller.js";
import { ReportService } from "./features/logs/report.service.js";
import { settingsDependencies } from "./features/settings/settings.adapter.js";
import { SettingsController } from "./features/settings/settings.controller.js";
import { SettingsService } from "./features/settings/settings.service.js";
import { StartAtSignInService } from "./features/settings/start-at-sign-in.service.js";
import { setupDependencies } from "./features/setup/setup.adapter.js";
import { SetupController } from "./features/setup/setup.controller.js";
import { SetupService } from "./features/setup/setup.service.js";
import { statusChecks } from "./features/status/status.adapter.js";
import { StatusController } from "./features/status/status.controller.js";
import { syncDependencies } from "./features/sync/sync.adapter.js";
import { SyncController } from "./features/sync/sync.controller.js";
import { presentSync } from "./features/sync/sync.presenter.js";
import { SyncService } from "./features/sync/sync.service.js";
import { transactionsDependencies, transactionsPageSize } from "./features/transactions/transactions.adapter.js";
import { TransactionsController } from "./features/transactions/transactions.controller.js";
import { TransactionsService } from "./features/transactions/transactions.service.js";
import { CloseNoticeService } from "./shared/close-notice.service.js";
import type { AllHandlers } from "./shared/controller.js";
import { DesktopStateService } from "./shared/desktop-state.service.js";
import {
  APP_LOG_MAX_BYTES,
  appLog,
  appVersion,
  databaseLog,
  describeError,
  profile,
  redact,
} from "./shared/domain.adapter.js";
import { registerHandlers } from "./shell/ipc-router.js";
import { MainWindow } from "./shell/main-window.js";
import { placeholderIcon } from "./shell/placeholder-icon.js";
import { startAtSignInRegistration, startedHidden } from "./shell/start-at-sign-in.js";
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
    app.setPath("userData", desktopDir(profile));

    // The log, before anything that could fail: a start that goes wrong is
    // the first thing anyone will want to read about. In the app's own folder,
    // beside Electron's files, so opening the app still creates no profile.
    configureLog({ path: desktopLogPath(profile), maxBytes: APP_LOG_MAX_BYTES, redact });
    const hidden = startedHidden(process.argv);
    log.info(`Costingly ${appVersion()} starting${hidden ? " hidden, for sign-in" : ""}`);

    if (!app.requestSingleInstanceLock()) {
      this.secondCopy = true;
      log.info("another copy of Costingly is already running; handing over to it");
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
    if (!this.secondCopy) log.info("Costingly stopped");
  }

  /**
   * Build the app. Every `new` in the desktop app is here.
   *
   * Release order is the reverse of registration: the window and tray go
   * first, and the database last — its service closes this process's
   * connections and then stops the server, after whatever it was already doing.
   */
  private async compose(): Promise<void> {
    // --- the database, brought up while Electron is still getting ready ------
    // The two waits overlap, and the first status check the window makes then
    // finds the database already up instead of reporting a stop about to end.
    const database = new DatabaseService(databaseDependencies());
    const databaseComingUp = database.bringUp();
    this.scope.onClose("database", () => database.stop());

    await app.whenReady();

    // --- what the window can ask for ----------------------------------------
    const databaseSection = databaseSectionReader(databaseSources, database);

    const setup = new SetupService({
      ...setupDependencies(),
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
    this.scope.onClose("link page", async () => void (await linkPage.stop()));

    // --- the sync, in the background -------------------------------------------
    // Started by the Sync button today; anything else that starts one later —
    // a schedule — calls the same `start()`, and the window hears about it the
    // same way. Quit does not wait for a run in flight: it silences the service
    // and lets the database stop, which fails whatever the run does next. No
    // query can start the database again, and the run's progress is committed
    // bank by bank, so nothing is lost and nothing is left running.
    const sync = new SyncService({
      ...syncDependencies(),
      now: () => new Date(),
      onChange: (state) => this.window?.emit("sync.changed", presentSync(state)),
    });
    this.scope.onClose("sync", async () => sync.stop());

    // Starting at sign-in is a Windows registration; Electron reads and writes
    // it, and the service decides what to say about it.
    const startAtSignIn = new StartAtSignInService({
      ...startAtSignInRegistration(),
      describeError,
    });

    const handlers: AllHandlers = {
      ...new StatusController(statusChecks(), databaseSection).handlers(),
      ...new DatabaseController(database, databaseSection, databaseLog).handlers(),
      ...new SetupController(setup, (url) => shell.openExternal(url)).handlers(),
      ...new AccountsController(
        new AccountsService(accountsDependencies()),
        // An unlink takes exclusive use from the sync: the two never overlap.
        new UnlinkService({ ...unlinkDependencies(), exclusively: (work) => sync.runExclusive(work) }),
      ).handlers(),
      ...new LinkController(
        async () => shell.openExternal((await linkPage.start()).url),
        async (bankId) => shell.openExternal(await linkPage.startForReconnect(bankId)),
      ).handlers(),
      ...new SyncController(sync).handlers(),
      ...new TransactionsController(
        new TransactionsService(transactionsDependencies()),
        transactionsPageSize,
      ).handlers(),
      ...new SettingsController(
        new SettingsService({ ...settingsDependencies(), startAtSignIn }),
        startAtSignIn,
      ).handlers(),
      // The two logs, and the report. Copying is the clipboard's, which is
      // Electron's, handed in like the browser is above.
      ...new LogsController(
        { app: appLog, database: databaseLog },
        new ReportService({ ...reportDependencies(), lastFailure: () => database.lastFailure() }),
        (text) => clipboard.writeText(text),
        describeError,
      ).handlers(),
    };
    registerHandlers(handlers, {
      isAppWindow: (sender) => this.window?.owns(sender) ?? false,
      describe: describeError,
    });

    // --- the tray, and the notice it shows once ------------------------------
    const tray = new TrayIcon({
      icon,
      onOpen: () => this.window?.reveal(),
      onQuit: () => this.requestQuit(),
    });
    this.scope.onClose("tray", async () => tray.destroy());

    const closeNotice = new CloseNoticeService(
      new DesktopStateService(desktopStatePath(profile)),
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
    // Started at sign-in, the app comes up in the tray and shows no window:
    // the registration launches it with the flag (shell/start-at-sign-in.ts).
    await window.open({ show: !startedHidden(process.argv) });
  }

  private requestQuit(): void {
    if (this.resolveQuit !== undefined) log.info("quit requested");
    this.resolveQuit?.();
    this.resolveQuit = undefined;
  }
}
