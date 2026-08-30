/**
 * An expected failure: printed as a bare message with no stack trace, and with
 * a chosen exit code.
 *
 * Use it for conditions the user can act on — a missing --env-file, a port
 * already in use. Anything else should throw normally, so a genuine bug still
 * shows where it came from.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
