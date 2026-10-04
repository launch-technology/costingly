/**
 * The renderer's client for the main process.
 *
 * Two functions, typed by the contract: `call` something, or listen `on` an
 * event. A call that is not in the contract, or is given the wrong arguments,
 * does not compile. Hooks use these; screens and components do not — they get
 * what they need from a hook.
 */

import type {
  Call,
  CallArgs,
  CallResult,
  DesktopEvent,
  DesktopEvents,
} from "../../bridge/contract.js";

export function call<K extends Call>(name: K, ...args: CallArgs<K>): Promise<CallResult<K>> {
  return window.costingly.invoke(name, ...args);
}

/** Subscribe to an event from the main process. Returns the unsubscribe. */
export function on<E extends DesktopEvent>(
  event: E,
  listener: (...args: DesktopEvents[E]) => void,
): () => void {
  return window.costingly.on(event, listener);
}
