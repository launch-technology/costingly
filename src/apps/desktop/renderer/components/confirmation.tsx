/**
 * Something just worked, said in a green line: "Keys saved.", "The report is
 * on the clipboard." The counterpart of Alert. Extra attributes (a test id)
 * pass through to the line.
 */

import type { HTMLAttributes } from "react";

export function Confirmation({ children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
      {...rest}
    >
      {children}
    </p>
  );
}
