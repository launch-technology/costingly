/**
 * The About screen: what this program is.
 *
 * Drawing only; the facts are hooks/use-about.ts. The version is the one to
 * find first, so it is the headline. Nothing here is typed in by hand: every
 * line comes from the program's own package description, read when asked, so
 * a new release describes itself.
 */

import { Alert } from "../../components/alert.js";
import { useAbout } from "../../hooks/use-about.js";

export function AboutScreen() {
  const about = useAbout();

  return (
    <section data-testid="about-screen" data-state={about.phase}>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">About</h1>
      </header>

      {about.phase === "loading" && (
        <p data-testid="about-loading" className="text-sm text-slate-600 dark:text-slate-300">
          Loading…
        </p>
      )}

      {about.phase === "failed" && (
        <Alert data-testid="about-problem" title={about.problem.cause}>
          <p className="mt-1">{about.problem.nextStep}</p>
        </Alert>
      )}

      {about.phase === "loaded" && (
        <div className="flex max-w-xl flex-col gap-6 text-sm">
          <section>
            <p className="text-xl font-semibold">
              Costingly <span data-testid="about-version">{about.view.version}</span>
            </p>
            {about.view.description !== "" && (
              <p data-testid="about-description" className="mt-1 text-slate-600 dark:text-slate-300">
                {about.view.description}
              </p>
            )}
          </section>

          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
            <dt className="text-slate-500 dark:text-slate-400">Version</dt>
            <dd>{about.view.version}</dd>
            {about.view.author !== "" && (
              <>
                <dt className="text-slate-500 dark:text-slate-400">By</dt>
                <dd data-testid="about-author">{about.view.author}</dd>
              </>
            )}
            {about.view.license !== "" && (
              <>
                <dt className="text-slate-500 dark:text-slate-400">Licence</dt>
                <dd data-testid="about-license">{about.view.license}</dd>
              </>
            )}
            <dt className="text-slate-500 dark:text-slate-400">Your data</dt>
            <dd data-testid="about-data-folder" className="break-all font-mono">
              {about.view.dataFolder}
            </dd>
          </dl>

          <p className="text-slate-600 dark:text-slate-300">
            Costingly keeps a private copy of your transactions on this computer. Nothing is sent anywhere except to
            your banks, through Plaid, when you link or sync them.
          </p>
        </div>
      )}
    </section>
  );
}
