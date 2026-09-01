/**
 * An Executor that is already inside BEGIN.
 *
 * What a service receives from `DataSource.transaction` and passes down to
 * repositories, which accept it as the plain `Executor` it also is. The
 * distinction exists for the service layer's benefit — transaction scope is its
 * decision — and deliberately never appears in a repository signature: a
 * repository runs the SQL it is given on the executor it is handed, and knows
 * nothing about how that executor was obtained.
 *
 * The brand is what stops a `Transaction` being satisfied by any object with a
 * `query` method, so a service cannot claim to be in one by accident.
 */

import type { Executor } from "./executor.js";

/**
 * Declared, never defined: it exists only in the type system, and nothing can
 * produce a value carrying it except `DataSource.transaction`, which asserts it
 * on the client it opens.
 */
declare const IN_TRANSACTION: unique symbol;

export interface Transaction extends Executor {
  readonly [IN_TRANSACTION]: true;
}
