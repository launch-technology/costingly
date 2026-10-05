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
 * WHO STARTED IT IS RECORDED, AND DOES NOT MATTER TO ANYTHING ELSE. Today the
 * only trigger is the Sync button. A scheduled sync is a second caller of
 * `start()`, with a second trigger name — nothing about running, remembering
 * or announcing a sync depends on which it was.
 *
 * Never throws and never rejects. A sync that cannot run at all is a state
 * (`failed`), like every other way it can end.
 *
 * No Electron and no domain imports beyond types.
 */

import type { SyncSummary } from "../../../../domain/services/banks/sync.types.js";

/** What set a sync going. One value today; a schedule would be another. */
export type SyncTrigger = "manual";

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

  constructor(private readonly deps: SyncDependencies) {}

  state(): SyncState {
    return this.current;
  }

  /**
   * Start a sync, unless one is running. Returns the state as it is now —
   * which, having just started, is `running`.
   */
  start(trigger: SyncTrigger = "manual"): SyncState {
    if (this.stopped || this.current.phase === "running") return this.current;

    this.change({ phase: "running", trigger, startedAt: this.deps.now() });
    void this.runToEnd(trigger);
    return this.current;
  }

  /**
   * The app is quitting. A run in flight is NOT waited for — a first sync can
   * take minutes — and nothing more is announced or started. It loses nothing:
   * the domain commits each bank's rows together with the marker that says how
   * far it got, so the next sync resumes from there.
   */
  stop(): void {
    this.stopped = true;
  }

  private async runToEnd(trigger: SyncTrigger): Promise<void> {
    let ended: SyncState;
    try {
      ended = { phase: "finished", trigger, summary: await this.deps.run() };
    } catch (error) {
      ended = { phase: "failed", trigger, reason: this.deps.describeError(error) };
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
  }
}
