/**
 * The one way anything below a terminal writes a diagnostic.
 *
 * Three levels and one place to send them. Before anything configures it,
 * warnings and errors go to stderr and information is dropped — which is what
 * a command-line run and a healthy MCP server want: stdout is the protocol
 * channel for one and the answer for the other, and neither wants a running
 * commentary on stderr. An application that stays up configures a file, and
 * from then on every level lands in it.
 *
 * ONE FILE, TRIMMED IN PLACE. There is no rotation and never a second file.
 * When the file passes its cap, the oldest part is dropped and the newest whole
 * lines kept, to a size comfortably under the cap so the trim is rare rather
 * than on every write. History past the cap is gone; the log exists to explain
 * the last failure, not to archive the year.
 *
 * NEVER THROWS, NEVER WAITS. A log that could take the program down with it
 * would be worse than no log. Writes are synchronous — open, append, close —
 * so lines land in order and two processes sharing the file for a moment
 * interleave rather than corrupt. A write that fails is reported once to
 * stderr and then given up on. A redactor that fails costs the message, not
 * the line: a placeholder is written in its place, never the unchecked text.
 *
 * Imported directly, not injected. A logger is cross-cutting, and threading it
 * through every constructor would say nothing about any of them.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "info" | "warn" | "error";

/** Where the lines go once an application has decided. */
export interface LogFileSink {
  path: string;
  /** The file is kept under this. */
  maxBytes: number;
  /** Applied to every message before it is written. */
  redact?: (text: string) => string;
}

/** Something that wants the lines as they are produced — tests, mostly. */
export type LogCapture = (level: LogLevel, message: string) => void;

/** How much of the cap a trim keeps. The rest is headroom before the next. */
const KEEP_FRACTION = 0.8;

/** Written in place of a message the redactor failed on. */
const WITHHELD = "[message withheld: it could not be checked for secrets]";

interface Sink {
  write(level: LogLevel, message: string): void;
}

const STDERR: Sink = {
  write(level, message) {
    if (level === "info") return;
    process.stderr.write(`${formatLine(level, message)}\n`);
  },
};

let sink: Sink = STDERR;

/**
 * Send the lines somewhere: a file (trimmed now if it is already over its
 * cap, and whenever a write takes it over), a capture function, or nothing to
 * go back to the default.
 */
export function configureLog(target: LogFileSink | LogCapture | undefined): void {
  if (target === undefined) sink = STDERR;
  else if (typeof target === "function") sink = { write: target };
  else sink = fileSink(target);
}

export const log = {
  info: (message: string): void => write("info", message),
  warn: (message: string): void => write("warn", message),
  error: (message: string): void => write("error", message),
};

function write(level: LogLevel, message: string): void {
  try {
    sink.write(level, message);
  } catch {
    // Reporting a failure to report would loop. The file sink already said
    // what it could.
  }
}

/** The local time to the second, the level, the message. */
export function formatLine(level: LogLevel, message: string): string {
  return `${timestamp()} ${level.toUpperCase().padEnd(5)} ${message}`;
}

function timestamp(now: Date = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`
  );
}

function fileSink(options: LogFileSink): Sink {
  const redact = options.redact ?? ((text: string): string => text);
  let complained = false;
  let withheld = false;
  let bytes = 0;

  const complain = (error: unknown): void => {
    if (complained) return;
    complained = true;
    process.stderr.write(
      `the log file could not be written (${options.path}): ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };

  try {
    mkdirSync(dirname(options.path), { recursive: true });
    trimLogFile(options.path, options.maxBytes);
    bytes = sizeOf(options.path);
  } catch (error) {
    complain(error);
  }

  return {
    write(level, message) {
      let safe: string;
      try {
        safe = redact(message);
      } catch {
        // A message that could not be checked for secrets is not written, and
        // neither is why, here or on stderr: the usual cause is a settings
        // file that cannot be read, and its error quotes the file. The line
        // still lands, so the log shows that something happened and when.
        safe = WITHHELD;
        if (!withheld) {
          withheld = true;
          process.stderr.write(`log messages could not be checked for secrets and are being withheld (${options.path})\n`);
        }
      }
      const line = `${formatLine(level, safe)}\n`;
      try {
        appendFileSync(options.path, line, "utf8");
      } catch (error) {
        // The folder may have gone from under us. Once.
        try {
          mkdirSync(dirname(options.path), { recursive: true });
          appendFileSync(options.path, line, "utf8");
        } catch {
          complain(error);
          return;
        }
      }
      bytes += Buffer.byteLength(line, "utf8");
      if (bytes > options.maxBytes) {
        try {
          trimLogFile(options.path, options.maxBytes);
        } catch (error) {
          complain(error);
        }
        bytes = sizeOf(options.path);
      }
    },
  };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Keep a log file under its cap by dropping its oldest part.
 *
 * Keeps the newest whole lines, to a size well under the cap. A file under
 * the cap, or no file, is left alone. Replaces the file in one write, so it
 * must not be called on a file another program holds open for appending —
 * the desktop app trims the database's log only while the database is
 * stopped. Throws on a file it cannot read or write; callers decide what a
 * failed trim means to them.
 */
export function trimLogFile(path: string, maxBytes: number): "trimmed" | "unchanged" | "missing" {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (size <= maxBytes) return "unchanged";

  const keep = Math.max(1, Math.floor(maxBytes * KEEP_FRACTION));
  const from = size - keep;
  const buffer = Buffer.alloc(keep);
  const file = openSync(path, "r");
  let read: number;
  try {
    read = readSync(file, buffer, 0, keep, from);
  } finally {
    closeSync(file);
  }
  const tail = buffer.subarray(0, read);
  // The tail starts mid-line; the fragment before the first line ending is not a line.
  const firstBreak = tail.indexOf(0x0a);
  const kept = firstBreak === -1 ? Buffer.alloc(0) : tail.subarray(firstBreak + 1);
  writeFileSync(path, kept);
  return "trimmed";
}
