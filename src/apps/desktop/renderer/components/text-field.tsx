/**
 * A labelled text input that can say it is required.
 *
 * `testId` names the input; the "Required." line under it is
 * `<testId>-required`.
 */

export interface TextFieldProps {
  id: string;
  testId: string;
  label: string;
  /** `password` hides what is typed. */
  type?: "text" | "password";
  value: string;
  onChange(value: string): void;
  /** The field was left empty when it must not be. */
  missing?: boolean;
  disabled?: boolean;
}

export function TextField({
  id,
  testId,
  label,
  type = "text",
  value,
  onChange,
  missing = false,
  disabled = false,
}: TextFieldProps) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        data-testid={testId}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={missing}
        autoComplete="off"
        spellCheck={false}
        className={
          "w-full rounded-md border bg-white px-3 py-2 text-sm disabled:opacity-60 dark:bg-slate-900 " +
          (missing ? "border-rose-500" : "border-slate-300 dark:border-slate-700")
        }
      />
      {missing && (
        <p data-testid={`${testId}-required`} className="mt-1 text-sm text-rose-600 dark:text-rose-400">
          Required.
        </p>
      )}
    </div>
  );
}
