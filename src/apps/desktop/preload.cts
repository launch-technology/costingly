/**
 * The bridge between the window and the main process.
 *
 * Everything the page can do is listed here, and it is short on purpose: three
 * status checks and one event. The page gets no `require`, no `ipcRenderer`
 * and no node — `contextBridge` hands it exactly this object and nothing else.
 *
 * CommonJS because the window is sandboxed, and a sandboxed preload cannot be
 * an ES module. Hence the `.cts` extension and the `require` form of import;
 * tsc emits it as preload.cjs beside the rest of the ESM build.
 */

import electron = require("electron");
import type { CostinglyApi, SectionView } from "./status-view.types.js";

const { contextBridge, ipcRenderer } = electron;

const api: CostinglyApi = {
  status: {
    profile: () => ipcRenderer.invoke("status:profile") as Promise<SectionView>,
    database: () => ipcRenderer.invoke("status:database") as Promise<SectionView>,
    plaid: () => ipcRenderer.invoke("status:plaid") as Promise<SectionView>,
  },
  onWindowShown: (listener) => {
    // Wrapped so the page's function never receives the IPC event object.
    const handler = (): void => listener();
    ipcRenderer.on("window:shown", handler);
    return () => ipcRenderer.removeListener("window:shown", handler);
  },
};

contextBridge.exposeInMainWorld("costingly", api);
