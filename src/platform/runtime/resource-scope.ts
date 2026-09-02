/**
 * The things an application acquired, released in reverse.
 *
 * Reverse order is the whole point: a resource acquired later may depend on one
 * acquired earlier, so unwinding in acquisition order can release something that
 * is still in use. LIFO is the only order that cannot.
 *
 * Every release is attempted even when an earlier one throws. A failure during
 * teardown must not strand the resources behind it — the process is on its way
 * out, and a leaked listener keeps it alive forever.
 */

export interface Closeable {
  close(): Promise<void>;
}

export class ResourceScope {
  private readonly held: Array<{ name: string; close: () => Promise<void> }> = [];

  /** Register something to release later. Returns it, so it can be assigned. */
  use<T extends Closeable>(name: string, resource: T): T {
    this.held.push({ name, close: () => resource.close() });
    return resource;
  }

  /** Register a release step that is not an object — a module-level stop(). */
  onClose(name: string, close: () => Promise<unknown>): void {
    this.held.push({ name, close: async () => void (await close()) });
  }

  /**
   * Release everything, most recent first. Never throws.
   *
   * Failures are reported and collected rather than raised: by the time this
   * runs the caller has usually already failed, and the original error is the
   * one worth reading.
   */
  async closeAll(): Promise<void> {
    while (this.held.length > 0) {
      const entry = this.held.pop();
      if (entry === undefined) break;
      try {
        await entry.close();
      } catch (error) {
        console.error(
          `[runtime] releasing ${entry.name} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
