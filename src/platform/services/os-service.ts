/**
 * Talking to the operating system.
 *
 * Today that means one thing — running a program and collecting what it said —
 * but the service exists so there is somewhere for the next one to go, and so
 * that the places where Windows and unix genuinely differ have a single home
 * rather than a platform check in whichever file noticed first.
 *
 * A service rather than loose functions for a reason beyond tidiness: nothing
 * could previously fake a subprocess, so every test touching a cluster had to
 * spawn real PostgreSQL binaries. Injected, a caller can be handed a stub whose
 * `pg_ctl` reports an exit code of its choosing — which is how the states worth
 * testing (a server that lies about being stopped, a missing binary) become
 * reachable at all.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /**
   * Merged over the current environment for the child.
   *
   * Deliberately additive: a program inheriting nothing behaves differently
   * from one inheriting a trimmed environment, and neither is what a caller
   * asking for one variable meant.
   */
  env?: NodeJS.ProcessEnv;

  /**
   * Prefix for the temporary capture files. Diagnostic only.
   *
   * They are deleted on the way out, so this matters exactly once: when a run
   * leaves them behind, and somebody has to work out which program did it.
   */
  label?: string;
}

export class OsService {
  /**
   * Run a program and return its exit code rather than throwing on one.
   *
   * WHY FILES AND NOT PIPES
   *
   * `execFile` — and any `spawn` with `stdio: "pipe"` — resolves on the child's
   * `close` event, which waits for the process to exit AND for its stdio to
   * reach EOF. A program that daemonises leaves a grandchild holding copies of
   * those pipe handles for the life of the daemon, so EOF never arrives and the
   * call hangs forever even though the program itself exited in under a second.
   *
   * On Windows this is unavoidable: `CreateProcess` with `bInheritHandles=TRUE`
   * duplicates every inheritable handle. Unix escapes only when the program
   * happens to reassign its daemon's streams. So this is applied to every call
   * rather than hidden behind a platform check.
   *
   * Files have no EOF to wait for. The daemon inherits a file handle nobody is
   * blocked on, and `exit` is the whole story.
   */
  async run(
    file: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const base = join(tmpdir(), `${options.label ?? "os"}-${process.pid}-${randomUUID()}`);
    const outPath = `${base}.out`;
    const errPath = `${base}.err`;

    // Unique per call, deliberately. A daemon keeps its inherited handles for
    // hours, so a fixed path would mean the next run opens `"w"` — truncate on
    // open — against a file another process still holds.
    const out = await open(outPath, "w");
    let err: Awaited<ReturnType<typeof open>> | undefined;

    try {
      err = await open(errPath, "w");

      const child = spawn(file, [...args], {
        env: { ...process.env, ...options.env },
        stdio: ["ignore", out.fd, err.fd],
        // A parent that HAS a console lends it to a console application and
        // nothing appears — which is every test run, from a terminal. A GUI
        // parent has no console, so Windows creates one per child: a window
        // flashes and steals focus. Ignored on unix.
        windowsHide: true,
      });

      // `error` matters as much as `exit`: a missing binary emits the former
      // and never the latter, which would hang exactly like the bug above.
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (c) => resolve(c ?? 1));
      });

      return {
        code,
        stdout: await readFile(outPath, "utf8").catch(() => ""),
        stderr: await readFile(errPath, "utf8").catch(() => ""),
      };
    } finally {
      await out.close().catch(() => {});
      await err?.close().catch(() => {});
      // Best effort: Node opens with FILE_SHARE_DELETE so this succeeds even
      // while a daemon holds the handle. If it ever does not, a uniquely named
      // file in the temp directory is the OS's problem, not ours.
      await unlink(outPath).catch(() => {});
      await unlink(errPath).catch(() => {});
    }
  }
}
