/**
 * What every executable on this platform is.
 *
 * Three phases, in a fixed order, run by an ApplicationHost that owns the
 * process around them:
 *
 *   start()   acquire and compose. Nothing has happened before this.
 *   run()     the work. Returns when the application is finished — for a CLI
 *             that is one command; for a server it is when the client hangs up.
 *   stop()    release. Runs even when run() threw, exactly once.
 *
 * `stop()` exists so that releasing resources is a phase rather than a habit.
 * Before this interface the CLI released the pool in a `finally`, the MCP server
 * released the link server through a shutdown hook, and one command released its
 * own listener — three owners, and a listening socket left behind whenever a
 * link failed part-way.
 */

export interface Application {
  /** For diagnostics and the host's error prefix. */
  readonly name: string;

  start(): Promise<void>;

  /**
   * The work. The process stays alive until this resolves.
   *
   * Throwing here is normal: the host reports it, sets an exit code and still
   * runs `stop()`.
   */
  run(): Promise<void>;

  stop(): Promise<void>;
}
