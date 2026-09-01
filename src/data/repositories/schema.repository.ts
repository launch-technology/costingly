/**
 * What the data means — assembled from the database itself, not written down.
 *
 * Anything writing SQL against this database needs two kinds of knowledge:
 *
 *   structure   information_schema — column names, types, nullability
 *   meaning     COMMENT ON, on the views (see the view layer in schema.sql)
 *
 * Both live in Postgres, so this is generated rather than maintained by hand. A
 * markdown file describing the schema is a file that drifts; a column added
 * without a comment shows up here immediately, and the test suite fails on it.
 *
 * Deliberately describes the VIEWS, never the base tables. The views are the
 * read surface, they are what `role_readonly` can reach, and they are where the
 * comments live — Postgres does not propagate a table's comments to a view.
 *
 * DELIBERATELY EXCLUDES anything that changes when a sync runs: no row counts,
 * no date range, no list of the categories or accounts present. Two reasons.
 *
 * The first is caching. This document is static between migrations, so a caller
 * can compute it once per process and reuse it forever. Fold in a row count and
 * that stops being true — the cache would confidently report yesterday's
 * numbers, which is worse than not reporting them.
 *
 * The second is that enumerating values is speculative. Listing every category
 * on the chance somebody filters by category means also listing merchants,
 * payment channels and subtypes, and paying for all of it on every call. The
 * column comments instead tell a reader to enumerate what it needs, at the
 * moment it is looking at that column — `SELECT DISTINCT category FROM
 * v_transactions` costs one query and only happens when it matters.
 */

import type { Executor } from "../db/types/executor.js";

/** The views that make up the read surface, in the order they are documented. */
const VIEWS = ["v_transactions", "v_accounts", "v_items"] as const;

export interface ColumnDoc {
  name: string;
  type: string;
  nullable: boolean;
  /** From COMMENT ON COLUMN. Null when nobody has written one. */
  comment: string | null;
}

export interface ViewDoc {
  name: string;
  comment: string | null;
  columns: ColumnDoc[];
}

export interface DatabaseDoc {
  views: ViewDoc[];
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  comment: string | null;
}

/**
 * Build the document. Two queries, no table scans — nothing here counts rows.
 *
 * Takes an Executor so a caller that cares can run both inside one transaction:
 * the two queries describe the same schema, and a migration landing between
 * them would produce a document that agrees with neither.
 */
export async function describeDatabase(exec: Executor): Promise<DatabaseDoc> {
  const list = VIEWS.map((v) => `'${v}'`).join(", ");

  // Structure and meaning together: col_description() is how a COMMENT ON
  // COLUMN is read back, keyed by the relation's oid and the column's number.
  const { rows: columns } = await exec.query<ColumnRow>(`
    SELECT c.table_name,
           c.column_name,
           c.data_type,
           c.is_nullable,
           col_description(a.attrelid, a.attnum) AS comment
      FROM information_schema.columns c
      JOIN pg_class     rel ON rel.relname = c.table_name
      JOIN pg_namespace ns  ON ns.oid = rel.relnamespace AND ns.nspname = c.table_schema
      JOIN pg_attribute a   ON a.attrelid = rel.oid AND a.attname = c.column_name
     WHERE c.table_schema = 'public' AND c.table_name IN (${list})
     ORDER BY c.table_name, c.ordinal_position`);

  const { rows: viewComments } = await exec.query<{ name: string; comment: string | null }>(`
    SELECT relname AS name, obj_description(oid) AS comment
      FROM pg_class
     WHERE relname IN (${list})`);
  const commentFor = new Map(viewComments.map((v) => [v.name, v.comment]));

  return {
    views: VIEWS.map((name) => ({
      name,
      comment: commentFor.get(name) ?? null,
      columns: columns
        .filter((c) => c.table_name === name)
        .map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES",
          comment: c.comment,
        })),
    })),
  };
}
