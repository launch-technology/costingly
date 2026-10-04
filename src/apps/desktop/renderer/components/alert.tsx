/**
 * Something went wrong, said in a box: a title, then whatever explains it.
 *
 * Announced to assistive technology as an alert. Extra attributes (a test id,
 * a `data-kind`) pass through to the box.
 */

import type { HTMLAttributes, ReactNode } from "react";

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  children?: ReactNode;
}

export function Alert({ title, children, ...rest }: AlertProps) {
  return (
    <div
      role="alert"
      className="mb-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100"
      {...rest}
    >
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

/** The underlying reason inside an alert — someone else's words, shown as given. */
export function AlertReason({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 whitespace-pre-wrap break-words text-rose-700 dark:text-rose-300">{children}</p>
  );
}
