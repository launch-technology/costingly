/**
 * The left sidebar. Lists only the screens that exist.
 *
 * The list is data so that adding a screen is adding a row, and so the
 * sidebar never advertises something that is not built yet — a dead-end entry
 * is exactly the kind of UI the stories promise not to ship.
 */

export type ScreenId = "status" | "accounts";

const SCREENS: ReadonlyArray<{ id: ScreenId; label: string }> = [
  { id: "status", label: "Status" },
  { id: "accounts", label: "Accounts" },
];

export interface SidebarProps {
  current: ScreenId;
  onSelect(screen: ScreenId): void;
}

export function Sidebar({ current, onSelect }: SidebarProps) {
  return (
    <nav
      aria-label="Screens"
      className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-slate-50 px-3 py-5 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="mb-6 px-2 text-lg font-semibold tracking-tight">Costingly</div>
      <ul className="flex flex-col gap-1">
        {SCREENS.map((screen) => {
          const selected = screen.id === current;
          return (
            <li key={screen.id}>
              <button
                type="button"
                data-testid={`nav-${screen.id}`}
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelect(screen.id)}
                className={
                  "w-full rounded-md px-3 py-2 text-left text-sm transition-colors " +
                  (selected
                    ? "bg-slate-200 font-medium dark:bg-slate-800"
                    : "hover:bg-slate-200/60 dark:hover:bg-slate-800/60")
                }
              >
                {screen.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
