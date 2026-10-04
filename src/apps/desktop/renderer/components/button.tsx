/**
 * The app's button, in the three forms it comes in.
 *
 *   primary     the one thing to do next on a screen
 *   secondary   something available but not the point (Refresh)
 *   link        an action that reads as text
 */

import type { ButtonHTMLAttributes } from "react";

const BASE = "text-sm disabled:cursor-default disabled:opacity-60";

const VARIANT = {
  primary:
    "rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 " +
    "dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300",
  secondary:
    "rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 " +
    "dark:border-slate-700 dark:hover:bg-slate-800",
  link:
    "text-sky-700 underline underline-offset-2 hover:text-sky-900 " +
    "dark:text-sky-400 dark:hover:text-sky-300",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT;
}

export function Button({ variant = "primary", type = "button", className, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE} ${VARIANT[variant]}${className === undefined ? "" : ` ${className}`}`}
      {...rest}
    />
  );
}
