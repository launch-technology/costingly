/**
 * What a controller is: one feature's answers to the window's calls.
 *
 * The desktop equivalent of a CLI command or an MCP tool — the place a
 * request from the interface arrives. A controller owns a feature prefix
 * (`status`, `setup`) and supplies a handler for every call in the contract
 * that starts with it. It holds no logic of its own worth testing: it asks a
 * service, and shapes the answer for the window.
 *
 * THE COMPILER KEEPS THIS HONEST. `HandlersFor<"setup">` is exactly the set of
 * `setup.*` calls in the contract, so a controller that misses one, misspells
 * one, or returns the wrong shape does not build. And the application has to
 * assemble an `AllHandlers` from its controllers, so a call that no
 * controller answers does not build either.
 *
 * No Electron here. Controllers are handed what they need — including the few
 * things only Electron can do — so they can be exercised without a window.
 */

import type { Call, CallArgs, CallResult } from "../../bridge/contract.js";

/** A handler for every call in the contract. */
export type AllHandlers = {
  [K in Call]: (...args: CallArgs<K>) => Promise<CallResult<K>>;
};

/** The handlers for one feature: every call named `<Prefix>.<something>`. */
export type HandlersFor<Prefix extends string> = Pick<
  AllHandlers,
  Extract<Call, `${Prefix}.${string}`>
>;

export interface Controller<Prefix extends string> {
  handlers(): HandlersFor<Prefix>;
}
