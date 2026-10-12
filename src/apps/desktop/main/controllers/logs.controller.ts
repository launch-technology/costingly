/**
 * The Logs screen's calls: read a log or the report, and copy either.
 *
 * COPYING HAPPENS HERE, NOT IN THE WINDOW. The text is assembled in the main
 * process and handed to the clipboard from there; the window names a log or
 * asks for the report and never sends text to be copied. The report is put
 * together afresh for a copy, so what is copied is how things stand now. The clipboard
 * function is Electron's, handed in by the application, as the browser-opening
 * function is to the setup and link controllers.
 *
 * A copy answers with what it copied, so the screen can show exactly the text
 * that is now on the clipboard. A clipboard that refuses is a result to show,
 * not a rejected call.
 */

import type { CopyLogResult, CopyReportResult, LogExcerpt, LogName, ReportView } from "../../bridge/contract.js";
import { copyFailed, presentReport } from "../presenters/report.presenter.js";
import type { ReportService } from "../services/report.service.js";
import type { Controller, HandlersFor } from "./controller.js";

/** How many lines the Logs screen shows. The report carries fewer (services/report.service.ts). */
export const VIEW_LINES = 500;

const LOG_NAMES: ReadonlySet<string> = new Set<LogName>(["app", "database"]);

export interface LogReaders {
  app: { excerpt(maxLines: number): Promise<LogExcerpt> };
  database: { excerpt(maxLines: number): Promise<LogExcerpt> };
}

export class LogsController implements Controller<"logs"> {
  constructor(
    private readonly logs: LogReaders,
    private readonly report: ReportService,
    /** Puts text on the clipboard. Electron's, handed in. */
    private readonly copyToClipboard: (text: string) => void,
    /** A safe one-line description of any error — never the error object. */
    private readonly describeError: (error: unknown) => string,
  ) {}

  handlers(): HandlersFor<"logs"> {
    return {
      "logs.read": (which) => this.reader(which).excerpt(VIEW_LINES),

      "logs.copy": async (which): Promise<CopyLogResult> => {
        const view = await this.reader(which).excerpt(VIEW_LINES);
        if (view.state !== "lines") {
          return { outcome: "failed", problem: copyFailed("The log", "there are no lines to copy yet") };
        }
        try {
          this.copyToClipboard(`${view.lines.join("\n")}\n`);
          return { outcome: "copied", view };
        } catch (error) {
          return { outcome: "failed", problem: copyFailed("The log", this.describeError(error)) };
        }
      },

      "logs.readReport": async (): Promise<ReportView> => ({ text: presentReport(await this.report.assemble()) }),

      "logs.copyReport": async (): Promise<CopyReportResult> => {
        try {
          const view: ReportView = { text: presentReport(await this.report.assemble()) };
          this.copyToClipboard(view.text);
          return { outcome: "copied", view };
        } catch (error) {
          return { outcome: "failed", problem: copyFailed("The report", this.describeError(error)) };
        }
      },
    };
  }

  /** The types say a LogName, but this is a process boundary. */
  private reader(which: unknown): LogReaders[LogName] {
    if (typeof which !== "string" || !LOG_NAMES.has(which)) throw new Error("That is not one of the logs.");
    return this.logs[which as LogName];
  }
}
