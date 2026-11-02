/**
 * The Connect screen: where a local MCP client reaches the app.
 *
 * Drawing only; the behaviour is hooks/use-connect.ts. Two things to copy —
 * the address and the token — and how the endpoint stands. The token is
 * hidden until Show is pressed; Copy works either way, because the copy
 * happens in the main process and never passes through this screen.
 *
 * A later story adds connecting Claude Desktop here. For now this is for any
 * MCP client on this computer, configured by hand.
 */

import type { ConnectView } from "../../../bridge/contract.js";
import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { Confirmation } from "../../components/confirmation.js";
import { useConnect } from "../../hooks/use-connect.js";

const HIDDEN_TOKEN = "••••••••••••••••••••••••";

export function ConnectScreen() {
  const connect = useConnect();
  const view = connect.state.phase === "loaded" ? connect.state.view : null;

  return (
    <section
      data-testid="connect-screen"
      data-state={connect.state.phase === "loaded" ? connect.state.view.state : connect.state.phase}
    >
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Connect</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Any MCP client on this computer can talk to Costingly through this address, with this token. Nothing is
          reachable from other computers.
        </p>
      </header>

      {connect.state.phase === "loading" && (
        <p data-testid="connect-loading" className="text-sm text-slate-600 dark:text-slate-300">
          Checking the endpoint…
        </p>
      )}

      {connect.state.phase === "failed" && (
        <Alert data-testid="connect-problem" title={connect.state.problem.cause}>
          <p className="mt-1">{connect.state.problem.nextStep}</p>
        </Alert>
      )}

      {view !== null && (
        <div className="flex max-w-xl flex-col gap-6">
          <Endpoint view={view} busy={connect.busy} onRetry={connect.retry} />

          <Field label="Address" testId="connect-address" value={view.address} placeholder="No address yet">
            <Button variant="secondary" data-testid="connect-copy-address" disabled={connect.busy || view.address === ""} onClick={connect.copyAddress}>
              Copy
            </Button>
          </Field>

          <Field
            label="Token"
            testId="connect-token"
            value={connect.token ?? HIDDEN_TOKEN}
            placeholder=""
            hidden={connect.token === null}
          >
            {connect.token === null ? (
              <Button variant="secondary" data-testid="connect-show-token" disabled={connect.busy} onClick={connect.showToken}>
                Show
              </Button>
            ) : (
              <Button variant="secondary" data-testid="connect-hide-token" onClick={connect.hideToken}>
                Hide
              </Button>
            )}
            <Button variant="secondary" data-testid="connect-copy-token" disabled={connect.busy} onClick={connect.copyToken}>
              Copy
            </Button>
          </Field>

          {connect.outcome?.kind === "copied" && <Confirmation data-testid="connect-copied">{connect.outcome.what}</Confirmation>}
          {connect.outcome?.kind === "failed" && (
            <Alert data-testid="connect-copy-problem" title={connect.outcome.problem.cause}>
              <p className="mt-1">{connect.outcome.problem.nextStep}</p>
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}

function Endpoint({ view, busy, onRetry }: { view: ConnectView; busy: boolean; onRetry(): void }) {
  return (
    <section data-testid="connect-endpoint">
      {view.state === "running" && (
        <p className="text-sm">
          <span className="font-medium">Running.</span> Clients can connect now.
        </p>
      )}
      {view.state === "stopped" && (
        <p className="text-sm">
          <span className="font-medium">Not running.</span> Clients cannot connect right now.
        </p>
      )}
      {view.movedFrom !== undefined && (
        <Alert data-testid="connect-moved" title="The address changed since the last run.">
          <p className="mt-1">
            It was {view.movedFrom}. Any client configured by hand needs the new address below.
          </p>
        </Alert>
      )}
      {view.problem !== undefined && (
        <Alert data-testid="connect-problem" title={view.problem.cause}>
          <p className="mt-1">{view.problem.nextStep}</p>
        </Alert>
      )}
      {view.canRetry && (
        <Button variant="secondary" data-testid="connect-retry" disabled={busy} onClick={onRetry}>
          Try again
        </Button>
      )}
    </section>
  );
}

function Field({
  label,
  testId,
  value,
  placeholder,
  hidden = false,
  children,
}: {
  label: string;
  testId: string;
  value: string;
  placeholder: string;
  hidden?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <code
          data-testid={testId}
          data-hidden={hidden ? "true" : "false"}
          className="break-all rounded bg-slate-100 px-2 py-1 text-sm dark:bg-slate-800"
        >
          {value === "" ? placeholder : value}
        </code>
        {children}
      </div>
    </section>
  );
}
