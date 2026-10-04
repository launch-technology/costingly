/**
 * The bridge between the window and the main process.
 *
 * Two functions and nothing else: make a call, listen for an event. WHICH
 * calls and events exist is contract.ts's business, checked by the compiler on
 * both sides, so this file does not grow when the app does. The page gets no
 * `require`, no `ipcRenderer` and no node — `contextBridge` hands it exactly
 * this object.
 *
 * A call the main process has no handler for is rejected there; this side
 * does not need its own list to stay safe, and a second list is a second
 * thing to keep in step.
 *
 * CommonJS because the window is sandboxed, and a sandboxed preload cannot be
 * an ES module — nor can it load other files of ours, which is why the
 * contract is imported for its types only. Hence the `.cts` extension and the
 * `require` form of import; tsc emits it as preload.cjs.
 */

import electron = require("electron");
import type { Bridge } from "./contract.js";

const { contextBridge, ipcRenderer } = electron;

const bridge: Bridge = {
  invoke: (call, ...args) => ipcRenderer.invoke(call, ...args),
  on: (event, listener) => {
    // Wrapped so the page's function never receives the IPC event object.
    const handler = (_event: unknown, ...args: unknown[]): void =>
      (listener as (...received: unknown[]) => void)(...args);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
};

contextBridge.exposeInMainWorld("costingly", bridge);
