/**
 * The process, around an Application.
 *
 * Everything true of *any* executable and nothing true of a particular one:
 * running the three phases in order, guaranteeing `stop()`, turning a thrown
 * error into an exit code, and swallowing EPIPE.
 *
 * An application never touches `process`. That is the boundary — a thing that
 * sets its own exit code cannot be embedded, tested in-process, or run twice.
 *
 * WHY stop() IS NOT IN A finally
 *
 * It is, but the guarantee matters more than the syntax: `stop()` runs after a
 * successful run, after a failed one, and after a failed `start()`. The last is
 * the case that used to leak — a link server that came up before the failure had
 * nothing to release it.
 */

import type { Application } from "./application.js";

/** Maps a thrown value to a message and an exit code. */
export interface ErrorReporter {
  (error: unknown): { message: string; exitCode: number };
}

const DEFAULT_REPORTER: ErrorReporter = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  exitCode: 1,
});

export interface LaunchOptions {
  /**
   * How to describe a failure, and what to exit with.
   *
   * Each interface words the same failure differently — a terminal gets
   * a setup hint, a model gets an explanation it can act on — so the mapping
   * belongs to the app, not here.
   */
  reportError?: ErrorReporter;

  /**
   * Where failures are written. stderr by default, and MUST stay stderr for an
   * MCP server: stdout is the protocol channel and one stray line corrupts the
   * session.
   */
  write?: (line: string) => void;
}

export class ApplicationHost {
  /**
   * Run an application to completion and settle the process.
   *
   * Never throws: a failure becomes a reported message and a non-zero exit
   * code, because by this point there is nobody above to catch it.
   */
  static async launch(app: Application, options: LaunchOptions = {}): Promise<void> {
    const report = options.reportError ?? DEFAULT_REPORTER;
    const write = options.write ?? ((line: string) => console.error(line));

    ApplicationHost.ignoreEpipe();

    try {
      await app.start();
      await app.run();
    } catch (error) {
      const { message, exitCode } = report(error);
      write(message);
      process.exitCode = exitCode;
    } finally {
      try {
        await app.stop();
      } catch (error) {
        // A teardown failure must not replace the exit code a real failure
        // already set, and must not become the last word about what went wrong.
        write(
          `[${app.name}] shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Exit quietly when a downstream pipe closes.
   *
   * `mycli txns | head` closes stdout while we are still writing, and under
   * MCP a closed stdout means the client is gone. Both surface as an unhandled
   * EPIPE and a stack trace in a log nobody asked for.
   */
  private static ignoreEpipe(): void {
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") process.exit(0);
    });
  }
}
