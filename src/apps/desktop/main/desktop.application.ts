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
 *   mcp/           the model's front door, a peer of features/: the tools a
 *                  local MCP client may call, their presenters, and the
 *                  handler that speaks MCP over HTTP
 *   routes/        every URL the app serves, one file per URL with the path
 *                  mirrored on disk, and index.ts the table
 *   shared/        what more than one feature uses
 *   shell/         the edges: the Electron objects (window, tray), and the
 *                  two transports requests arrive by, the IPC router and the
 *                  local web server
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
import { accountsDependencies, isLinkedBank, unlinkDependencies } from "./features/accounts/accounts.adapter.js";
import { AccountsController } from "./features/accounts/accounts.controller.js";
import { AccountsService } from "./features/accounts/accounts.service.js";
import { LinkController } from "./features/accounts/link.controller.js";
import { UnlinkService } from "./features/accounts/unlink.service.js";
import { localServerDependencies } from "./features/connect/connect.adapter.js";
import { ConnectController } from "./features/connect/connect.controller.js";
import { pageAddressOf, presentMcpSection, reconnectAddressOf } from "./features/connect/connect.presenter.js";
import { LocalServerService } from "./features/connect/local-server.service.js";
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
import {
  checkCostinglyDependencies,
  datastoreState,
  describeDatabaseDependencies,
  listBanks,
  queryDependencies,
  recentLinks,
} from "./mcp/mcp.adapter.js";
import { serverInfo } from "./mcp/server-info.js";
import { CheckCostinglyTool } from "./mcp/tools/check-costingly.tool.js";
import { DescribeDatabaseTool } from "./mcp/tools/describe-database.tool.js";
import { LinkBankTool } from "./mcp/tools/link-bank.tool.js";
import { QueryTool } from "./mcp/tools/query.tool.js";
import { RelinkBankTool } from "./mcp/tools/relink-bank.tool.js";
import { RestartDatabaseTool } from "./mcp/tools/restart-database.tool.js";
import { SetupCostinglyTool } from "./mcp/tools/setup-costingly.tool.js";
import { SyncStatusTool } from "./mcp/tools/sync-status.tool.js";
import { SyncTool } from "./mcp/tools/sync.tool.js";
import type { Tool } from "./mcp/tools/tool.js";
import { UnlinkBankTool } from "./mcp/tools/unlink-bank.tool.js";
import { routes } from "./routes/index.js";
import { linkRouteDependencies } from "./routes/link.adapter.js";
import { CloseNoticeService } from "./shared/close-notice.service.js";
import type { AllHandlers } from "./shared/controller.js";
import { DesktopStateService } from "./shared/desktop-state.service.js";
import {
  APP_LOG_MAX_BYTES,
  appLog,
  appVersion,
  databaseLog,
  describeError,
  keysPresent,
  profile,
  redact,
} from "./shared/domain.adapter.js";
import { registerHandlers } from "./shell/ipc-router.js";
import { LocalHttpServer } from "./shell/local-http-server.js";
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

    // --- the services the window and a model share -----------------------------
    const databaseSection = databaseSectionReader(databaseSources, database);

    // Setup and the setup_costingly tool create the database through the same
    // service, and explain a failure in the same words, as the status screen's
    // own button.
    const createDatabase = async () => {
      const failure = await database.create();
      return failure === undefined ? undefined : explainDatabaseFailure(failure).problem;
    };
    const setup = new SetupService({ ...setupDependencies(), createDatabase });

    // The sync, in the background. Started by the Sync button or by a model's
    // sync tool; anything else that starts one later — a schedule — calls the
    // same `start()`, and the window hears about it the same way. Quit does not
    // wait for a run in flight: it silences the service and lets the database
    // stop, which fails whatever the run does next. No query can start the
    // database again, and the run's progress is committed bank by bank, so
    // nothing is lost and nothing is left running.
    const sync = new SyncService({
      ...syncDependencies(),
      now: () => new Date(),
      onChange: (state) => this.window?.emit("sync.changed", presentSync(state)),
    });
    this.scope.onClose("sync", async () => sync.stop());

    // An unlink takes exclusive use from the sync, and unlinks queue behind
    // each other: the two never overlap, whoever asked for either.
    const unlinking = new UnlinkService({ ...unlinkDependencies(), exclusively: (work) => sync.runExclusive(work) });

    // --- the local server: where a model and a browser reach the app ----------
    // One web server on this machine only, up from here until Quit, whether
    // or not setup is finished and without waiting for the database: a client
    // that asks too early is told what is missing. Its routes are the table in
    // routes/index.ts: /mcp behind the token, the bank-link page and its calls
    // open. Registered after the database, so on Quit it stops answering
    // before the database stops.
    const now = (): Date => new Date();
    // The page's addresses need the local server's port, known once it has
    // started and asked each time, so a server that moved ports is followed.
    const port = (): number | undefined => localServer.state().port;
    const currentPort = (): number => {
      const current = port();
      if (current === undefined) throw new Error("The app's local server is not running. Press Try again on the Status screen.");
      return current;
    };
    const tools: Tool[] = [
      new CheckCostinglyTool(checkCostinglyDependencies()),
      new DescribeDatabaseTool(describeDatabaseDependencies()),
      new QueryTool(queryDependencies()),
      // Eight seconds: under the ten MCP Inspector allows a call by default.
      new SyncTool({ state: datastoreState, sync, now, waitMs: 8_000 }),
      new SyncStatusTool({ sync, now }),
      new LinkBankTool({
        keysPresent,
        state: datastoreState,
        pageAddress: () => {
          const current = port();
          return current === undefined ? undefined : pageAddressOf(current);
        },
        takeRecentLinks: recentLinks.takeRecentLinks,
      }),
      new RelinkBankTool({
        keysPresent,
        state: datastoreState,
        listBanks,
        reconnectAddress: (bankId) => {
          const current = port();
          return current === undefined ? undefined : reconnectAddressOf(current, bankId);
        },
        takeRecentRepairs: recentLinks.takeRecentRepairs,
      }),
      new UnlinkBankTool({ unlink: unlinking, listBanks }),
      new SetupCostinglyTool({ createDatabase, keysPresent }),
      new RestartDatabaseTool({ restart: () => database.restart(), section: databaseSection }),
    ];
    const http = new LocalHttpServer({
      routes: routes({
        mcp: {
          info: serverInfo(appVersion()),
          tools,
          observe: (tool, outcome) =>
            log.info(`mcp: ${tool} ${outcome === "ok" ? "answered" : outcome === "error" ? "answered with an error" : "threw"}`),
        },
        link: linkRouteDependencies(),
      }),
      onRefused: ({ reason, path }) => log.warn(`the local server refused a request to ${path}: ${reason}`),
    });
    const localServer: LocalServerService = new LocalServerService({
      ...localServerDependencies(),
      listen: (listenPort, token) => http.start(listenPort, token),
      close: () => http.stop(),
    });
    await localServer.start();
    this.scope.onClose("local server", () => localServer.stop());

    const icon = placeholderIcon();

    // Starting at sign-in is a Windows registration; Electron reads and writes
    // it, and the service decides what to say about it.
    const startAtSignIn = new StartAtSignInService({
      ...startAtSignInRegistration(),
      describeError,
    });

    const handlers: AllHandlers = {
      ...new StatusController(statusChecks(), databaseSection, async () => presentMcpSection(localServer.state())).handlers(),
      ...new DatabaseController(database, databaseSection, databaseLog).handlers(),
      ...new SetupController(setup, (url) => shell.openExternal(url)).handlers(),
      ...new AccountsController(new AccountsService(accountsDependencies()), unlinking).handlers(),
      // Linking a bank happens in the user's browser, on the page the app
      // itself serves at /pages/link. Nothing is started or stopped for it.
      ...new LinkController(
        async () => shell.openExternal(pageAddressOf(currentPort())),
        async (bankId) => {
          if (!(await isLinkedBank(bankId))) throw new Error("That bank is not one of your linked banks.");
          await shell.openExternal(reconnectAddressOf(currentPort(), bankId));
        },
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
      // The Connect screen: the endpoint's address and token. The token is
      // copied here and shown only when asked for.
      ...new ConnectController(localServer, (text) => clipboard.writeText(text), describeError).handlers(),
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
