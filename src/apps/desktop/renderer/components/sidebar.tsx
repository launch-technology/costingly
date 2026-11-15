/**
 * The left sidebar. Lists only the screens that exist.
 *
 * The list is data so that adding a screen is adding a row, and so the
 * sidebar never advertises something that is not built yet — a dead-end entry
 * is exactly the kind of UI the stories promise not to ship.
 *
 * The screens come in three groups, by how often anyone visits them: the
 * daily ones (the money), connecting Claude (set up once), and the app itself
 * (rarely). A gap separates the groups; no headings, because each group says
 * what it is by its members.
 */

export type ScreenId = "status" | "accounts" | "transactions" | "settings" | "logs" | "claude-desktop" | "connect" | "about";

interface Screen {
  id: ScreenId;
  label: string;
}

const GROUPS: ReadonlyArray<ReadonlyArray<Screen>> = [
  [
    { id: "accounts", label: "Accounts" },
    { id: "transactions", label: "Transactions" },
  ],
  [
    { id: "claude-desktop", label: "Claude Desktop" },
    { id: "connect", label: "Other clients" },
  ],
  [
    { id: "status", label: "Status" },
    { id: "settings", label: "Settings" },
    { id: "logs", label: "Logs" },
    { id: "about", label: "About" },
  ],
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
        {GROUPS.map((group, index) =>
          group.map((screen, position) => {
            const selected = screen.id === current;
            // The gap sits on the first row of every group but the first.
            const opensGroup = index > 0 && position === 0;
            return (
              <li key={screen.id} className={opensGroup ? "mt-5" : undefined}>
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
          }),
        )}
      </ul>
    </nav>
  );
}
