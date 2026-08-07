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
 * read surface, they are what `costingly_ro` can reach, and they are where the
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

import { query } from "./client.js";

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
 */
export async function describeDatabase(): Promise<DatabaseDoc> {
  const list = VIEWS.map((v) => `'${v}'`).join(", ");

  // Structure and meaning together: col_description() is how a COMMENT ON
  // COLUMN is read back, keyed by the relation's oid and the column's number.
  const { rows: columns } = await query<ColumnRow>(`
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

  const { rows: viewComments } = await query<{ name: string; comment: string | null }>(`
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

/**
 * Render the document as text.
 *
 * Plain prose rather than JSON: this is written to be *read* — by a person
 * debugging, or by a model deciding what to query — and a wall of nested JSON
 * costs tokens without adding clarity.
 */
export function renderDatabaseDoc(doc: DatabaseDoc): string {
  const out: string[] = [];

  out.push("costingly — local Postgres holding your bank and credit-card transactions.");
  out.push("");
  out.push("Query the v_ views below. The underlying tables are not readable: they hold");
  out.push("encrypted bank credentials and the raw Plaid payloads.");
  out.push("");
  out.push("This describes STRUCTURE ONLY. It does not tell you which values are present,");
  out.push("how many rows there are, or what period the data covers — those change every");
  out.push("time a sync runs. Before filtering on a literal, enumerate it:");
  out.push("");
  out.push("    SELECT DISTINCT category FROM v_transactions ORDER BY 1;");
  out.push("    SELECT MIN(date), MAX(date) FROM v_transactions;");
  out.push("");
  out.push("A filter on a value this database does not contain returns zero rows rather");
  out.push("than an error, which is indistinguishable from a real answer.");
  out.push("");

  for (const view of doc.views) {
    out.push(view.name);
    if (view.comment) out.push(indent(view.comment, 2));
    out.push("");
    for (const column of view.columns) {
      out.push(`  ${column.name}  ${column.type}${column.nullable ? "" : " NOT NULL"}`);
      if (column.comment) out.push(indent(column.comment, 6));
    }
    out.push("");
  }

  return out.join("\n").trimEnd();
}

/** Wrap a comment to a readable width at a given indent. */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = pad;
  for (const word of words) {
    if (line.length + word.length + 1 > 78 && line.trim() !== "") {
      lines.push(line);
      line = pad;
    }
    line += (line === pad ? "" : " ") + word;
  }
  if (line.trim() !== "") lines.push(line);
  return lines.join("\n");
}
