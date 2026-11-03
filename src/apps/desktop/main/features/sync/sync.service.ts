/**
 * The sync, as something the desktop app runs in the background.
 *
 * The sync itself — every linked bank, one failing without stopping the rest,
 * progress saved with the rows it describes — is the domain's, and is called
 * here exactly as the other interfaces call it. What this adds is what a
 * program that stays up needs around it:
 *
 *   IT IS STARTED, NOT AWAITED. `start()` returns at once. The run carries on
 *   in the background and nobody holds a call open for the minutes a first
 *   sync can take. Whoever wants to know how it went asks `state()`, or is
 *   told through `onChange`.
 *
 *   ONE AT A TIME. Starting while one is running starts nothing.
 *
 *   IT REMEMBERS THE LAST RUN. One result, the latest, until the next run
 *   replaces it. A window that was closed for the whole sync opens to find it.
 *
 * WHO STARTED IT IS RECORDED, AND DOES NOT MATTER TO ANYTHING ELSE. The Sync
 * button and a model's `sync` tool are two callers of `start()` with two
 * trigger names; a scheduled sync would be a third. Nothing about running,
 * remembering or announcing a sync depends on which it was, and a run one of
 * them started is the run all of them see.
 *
 * ANYONE MAY WAIT FOR THE RUN TO END. `whenSettled()` is the same announcement
 * the window gets through `onChange`, offered as something a caller can await
 * — a tool call that would like to answer with the result if it comes soon.
 * One promise per run: a waiter on one run is never answered by a later one.
 *
 * Never throws and never rejects. A sync that cannot run at all is a state
 * (`failed`), like every other way it can end.
 *
 * No Electron and no domain imports beyond types.
 */

import type { SyncSummary } from "../../../../../domain/services/banks/sync.types.js";
import { log } from "../../../../../platform/runtime/log.js";

/** What set a sync going: the button, or a model through the endpoint. */
export type SyncTrigger = "manual" | "mcp";

export type SyncState =
  | { phase: "idle" }
  | { phase: "running"; trigger: SyncTrigger; startedAt: Date }
  /** The sync ran. Individual banks may still have failed — see the summary. */
  | { phase: "finished"; trigger: SyncTrigger; summary: SyncSummary }
  /** The sync could not run at all. */
  | { phase: "failed"; trigger: SyncTrigger; reason: string };

export interface SyncDependencies {
  /** Sync every linked bank. The domain's, as it is. */
  run(): Promise<SyncSummary>;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
  now(): Date;
  /** Told every time the state changes: when a run starts, and when it ends. */
  onChange(state: SyncState): void;
}

export class SyncService {
  private current: SyncState = { phase: "idle" };
  private stopped = false;
  /** How many pieces of work currently hold exclusive use. Above zero, no sync starts. */
  private exclusive = 0;
  /** The current run's end, for whoever is waiting on it. Undefined between runs. */
  private settled: { promise: Promise<SyncState>; resolve: (state: SyncState) => void } | undefined;

  constructor(private readonly deps: SyncDependencies) {}

  state(): SyncState {
    return this.current;
  }

  /**
   * Start a sync, unless one is running. Returns the state as it is now —
   * which, having just started, is `running`.
   */
  start(trigger: SyncTrigger = "manual"): SyncState {
    if (this.stopped || this.current.phase === "running" || this.exclusive > 0) return this.current;

    let resolve: (state: SyncState) => void = () => {};
    const promise = new Promise<SyncState>((done) => {
      resolve = done;
    });
    this.settled = { promise, resolve };
    this.change({ phase: "running", trigger, startedAt: this.deps.now() });
    void this.runToEnd(trigger);
    return this.current;
  }

  /**
   * The state the current run ends in, once it does. Resolved at once with the
   * state as it is when no run is in progress.
   */
  whenSettled(): Promise<SyncState> {
    return this.settled?.promise ?? Promise.resolve(this.current);
  }

  /**
   * Run something that must not overlap a sync — unlinking a bank, say, which
   * deletes the rows a sync would be writing.
   *
   * Refused (`ran: false`) while a sync is running. Otherwise the work runs,
   * and until it settles no sync can start, whoever asks: the button, or
   * whatever starts syncs later. The rule lives here, with the sync, so it
   * cannot be got round by a caller that did not think to check.
   *
   * What the work throws is the caller's to handle; exclusive use is released
   * either way.
   */
  async runExclusive<T>(work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.current.phase === "running") return { ran: false };
    this.exclusive++;
    try {
      return { ran: true, value: await work() };
    } finally {
      this.exclusive--;
    }
  }

  /**
   * The app is quitting. A run in flight is NOT waited for — a first sync can
   * take minutes — and nothing more is announced or started. It loses nothing:
   * the domain commits each bank's rows together with the marker that says how
   * far it got, so the next sync resumes from there.
   */
  stop(): void {
    this.stopped = true;
    // A waiter is answered with what there is, rather than left hanging.
    this.settled?.resolve(this.current);
    this.settled = undefined;
  }

  private async runToEnd(trigger: SyncTrigger): Promise<void> {
    log.info(`sync started (${trigger})`);
    let ended: SyncState;
    try {
      const summary = await this.deps.run();
      for (const result of summary.results) {
        const bank = result.institutionName ?? result.itemId;
        if (result.ok) {
          log.info(`sync: ${bank}: ${result.added} added, ${result.modified} modified, ${result.removed} removed`);
        } else {
          log.warn(`sync: ${bank}: failed: ${result.error ?? "no reason given"}`);
        }
      }
      log.info(
        `sync finished: ${summary.itemsSucceeded} of ${summary.itemsTotal} bank${summary.itemsTotal === 1 ? "" : "s"} synced in ${summary.durationMs} ms`,
      );
      ended = { phase: "finished", trigger, summary };
    } catch (error) {
      const reason = this.deps.describeError(error);
      log.error(`sync failed: ${reason}`);
      ended = { phase: "failed", trigger, reason };
    }
    this.change(ended);
  }

  private change(state: SyncState): void {
    if (this.stopped) return;
    this.current = state;
    try {
      this.deps.onChange(state);
    } catch {
      // A listener that throws must not turn into a sync that failed.
    }
    if (state.phase === "finished" || state.phase === "failed") {
      this.settled?.resolve(state);
      this.settled = undefined;
    }
  }
}
