/**
 * The Claude Desktop screen: install the extension, and see whether Claude
 * Desktop is talking to the app.
 *
 * Drawing only; the behaviour is hooks/use-claude-desktop.ts. Two parts: how
 * the connection stands (not yet, heard from at a time with a version, or a
 * version that does not work with this app), and the file with the two ways
 * of giving it to Claude Desktop. Claude Desktop offers no way for another
 * program to install an extension, so the install is the user's step; this
 * screen makes it short.
 */

import type { ClaudeDesktopView } from "../../../bridge/contract.js";
import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { Confirmation } from "../../components/confirmation.js";
import { useClaudeDesktop } from "../../hooks/use-claude-desktop.js";

export function ClaudeDesktopScreen() {
  const claude = useClaudeDesktop();
  const view = claude.state.phase === "loaded" ? claude.state.view : null;

  return (
    <section
      data-testid="claude-desktop-screen"
      data-state={view === null ? claude.state.phase : view.connection.state}
      data-file={view === null ? "" : view.file.state}
    >
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Claude Desktop</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Claude Desktop reaches Costingly through a small extension. Install it once; after that, Claude can ask
            about your money while Costingly is running.
          </p>
        </div>
        <Button variant="secondary" data-testid="claude-desktop-refresh" onClick={claude.reload} disabled={claude.busy}>
          {claude.busy ? "Checking…" : "Refresh"}
        </Button>
      </header>

      {claude.state.phase === "loading" && (
        <p data-testid="claude-desktop-loading" className="text-sm text-slate-600 dark:text-slate-300">
          Checking…
        </p>
      )}

      {claude.state.phase === "failed" && (
        <Alert data-testid="claude-desktop-problem" title={claude.state.problem.cause}>
          <p className="mt-1">{claude.state.problem.nextStep}</p>
        </Alert>
      )}

      {view !== null && (
        <div className="flex max-w-xl flex-col gap-6">
          <Connection view={view} />
          <Install view={view} busy={claude.busy} onOpen={claude.openFolder} />

          {claude.outcome?.kind === "opened" && (
            <Confirmation data-testid="claude-desktop-opened">The folder is open, with the file selected.</Confirmation>
          )}
          {claude.outcome?.kind === "failed" && (
            <Alert data-testid="claude-desktop-open-problem" title={claude.outcome.problem.cause}>
              <p className="mt-1 break-all">{claude.outcome.problem.nextStep}</p>
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}

function Connection({ view }: { view: ClaudeDesktopView }) {
  const { connection } = view;
  return (
    <section data-testid="claude-desktop-status">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Connection</h2>
      {connection.state === "never" && (
        <p className="text-sm">
          <span className="font-medium">Not connected.</span> Claude Desktop has not connected since Costingly started.
          If the extension is installed, restart Claude Desktop; otherwise install it below.
        </p>
      )}
      {connection.state === "heard" && connection.compatible && (
        <p className="text-sm">
          <span className="font-medium">Connected.</span> Last heard from Claude Desktop at {when(connection.at)}.
          Extension {connection.version}, Costingly {view.appVersion}.
        </p>
      )}
      {connection.state === "heard" && !connection.compatible && (
        <Alert data-testid="claude-desktop-mismatch" title="The installed extension does not work with this version of Costingly.">
          <p className="mt-1">
            Claude Desktop has extension {connection.version}; Costingly is {view.appVersion}. Reinstall the extension from
            the file below, then restart Claude Desktop.
          </p>
        </Alert>
      )}
    </section>
  );
}

function Install({ view, busy, onOpen }: { view: ClaudeDesktopView; busy: boolean; onOpen(): void }) {
  const { file } = view;
  return (
    <section data-testid="claude-desktop-install">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Install the extension</h2>

      {file.state === "missing" && (
        <Alert data-testid="claude-desktop-missing" title="The extension file is not here.">
          <p className="mt-1 break-all">
            Nothing named costingly-&lt;version&gt;.mcpb is in {file.folder}. Run <code>{file.buildCommand}</code> in the
            repository to build it.
          </p>
        </Alert>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <code data-testid="claude-desktop-file" className="break-all rounded bg-slate-100 px-2 py-1 text-sm dark:bg-slate-800">
          {file.state === "found" ? file.path : "No extension file"}
        </code>
        <Button variant="secondary" data-testid="claude-desktop-open-folder" disabled={busy || file.state !== "found"} onClick={onOpen}>
          Open folder
        </Button>
      </div>

      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Open the folder and drag the file into the Claude Desktop window.</li>
        <li>
          If nothing happens, open Claude Desktop's settings and search them for &ldquo;extension&rdquo;: the page that
          lists installed extensions takes the file, dropped onto it or chosen through its install option. Where that
          page lives changes between Claude Desktop versions.
        </li>
        <li>Restart Claude Desktop. Nothing needs filling in: the extension finds Costingly by itself.</li>
      </ol>
    </section>
  );
}

/** "14:32" today, or the date as well on another day. */
function when(iso: string): string {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  return today ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleString();
}
