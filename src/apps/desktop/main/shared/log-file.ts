/**
 * A log file as the app reads it: the app's own, and the database's.
 *
 * Read for three purposes:
 *
 *   Evidence   the database service notes how long the database's log is
 *              before it tries to start the server, and afterwards reads only
 *              what was added — so it judges a failure by what THIS attempt
 *              wrote, not by something left from last week.
 *   Display    the last lines, for "Show details" on a failure and for the
 *              Logs screen.
 *   Room       a trim that keeps the file under its cap, run on the database's
 *              log while the database is stopped. The app's own log trims
 *              itself (platform/runtime/log.ts); this calls the same trim.
 *
 * EVERYTHING THAT LEAVES HERE IS REDACTED. A log can contain a password.
 * PostgreSQL records the text of any statement that fails, and one statement
 * costingly runs sets the application role's password inline — so if that
 * statement ever fails, the log holds the password in clear. Nothing here can
 * change what gets written to disk; what it can do is make sure the app never
 * shows it. Two nets: the statement shape itself, and the exact values of
 * every secret this profile holds, wherever they appear.
 */

import { open, stat } from "node:fs/promises";

import { log, trimLogFile } from "../../../../platform/runtime/log.js";
import type { LogExcerpt } from "../../bridge/contract.js";

/**
 * How much is read for an excerpt: enough to hold any plausible tail of the
 * lines asked for, without reading a log that has grown to its cap.
 */
const TAIL_BYTES = 512 * 1024;
const EXCERPT_LINES = 30;
const HIDDEN = "[hidden]";

/** A value shorter than this is too likely to match something innocent. */
const MIN_SECRET_LENGTH = 6;

export interface LogFileOptions {
  /** A name for the log in the app's own log. */
  name: string;
  /** The log file. A function: the profile, and so the path, can move. */
  path(): string;
  /** The same path as a person should see it. */
  displayPath(path: string): string;
  redact(text: string): string;
}

export class LogFile {
  constructor(private readonly options: LogFileOptions) {}

  /** Bytes written so far. Zero when there is no log yet. */
  async size(): Promise<number> {
    try {
      return (await stat(this.options.path())).size;
    } catch {
      return 0;
    }
  }

  /** What was written after `offset`, redacted. Empty when nothing was. */
  async readSince(offset: number): Promise<string> {
    const size = await this.size();
    // A log shorter than the mark was replaced; everything in it is new.
    const from = size < offset ? 0 : offset;
    if (size <= from) return "";
    return this.options.redact(await this.read(from, size - from));
  }

  /** The last lines of the log, for display. Never throws. */
  async excerpt(maxLines: number = EXCERPT_LINES): Promise<LogExcerpt> {
    const path = this.options.displayPath(this.options.path());

    let size: number;
    try {
      size = (await stat(this.options.path())).size;
    } catch (error) {
      // No file is an answer — the program has never written one. Anything
      // else is a log that exists and cannot be read.
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "empty", path }
        : { state: "unreadable", path };
    }
    if (size === 0) return { state: "empty", path };

    try {
      const from = Math.max(0, size - TAIL_BYTES);
      const text = this.options.redact(await this.read(from, size - from));
      const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
      // A tail that starts mid-file starts mid-line; that fragment is not a line.
      if (from > 0) lines.shift();
      const kept = lines.filter((line) => line.trim() !== "").slice(-maxLines);
      return kept.length === 0 ? { state: "empty", path } : { state: "lines", lines: kept, path };
    } catch {
      return { state: "unreadable", path };
    }
  }

  /**
   * Keep the file under `maxBytes` by dropping its oldest part. A missing
   * file, or one under the cap, is left alone. Never throws: a trim that
   * failed is logged, and whatever was about to happen goes ahead.
   */
  async trim(maxBytes: number): Promise<void> {
    try {
      if (trimLogFile(this.options.path(), maxBytes) === "trimmed") {
        log.info(`the ${this.options.name} log was over its cap and was trimmed`);
      }
    } catch (error) {
      log.warn(
        `the ${this.options.name} log could not be trimmed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async read(from: number, length: number): Promise<string> {
    const file = await open(this.options.path(), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, from);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  }
}

/**
 * Build the function that removes secrets from text about to be shown.
 *
 * `secrets` is asked every time rather than once: the database's passwords do
 * not exist until setup creates them, which is after the app has started.
 */
export function createRedactor(secrets: () => ReadonlyArray<string | undefined>): (text: string) => string {
  return (text) => {
    // The statement shape: PASSWORD '…' in any ALTER/CREATE ROLE, whatever the value.
    let safe = text.replace(/(PASSWORD\s+)'(?:[^']|'')*'/gi, `$1'${HIDDEN}'`);

    for (const secret of secrets()) {
      if (secret === undefined || secret.length < MIN_SECRET_LENGTH) continue;
      safe = safe.split(secret).join(HIDDEN);
    }
    return safe;
  };
}
