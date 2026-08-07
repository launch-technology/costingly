/**
 * What the data means — assembled at call time, not written down.
 *
 * Anything writing SQL against this database needs three different kinds of
 * knowledge, and they live in three different places:
 *
 *   structure   information_schema — column names, types, nullability
 *   meaning     COMMENT ON, on the views (see the view layer in schema.sql)
 *   live facts  the database itself — the actual date range, the real account
 *               names, the categories genuinely present
 *
 * The third is why this is a function rather than a markdown file. No static
 * document can say "your data spans 2024-08-08 to 2026-08-06" or list your four
 * accounts by name, and those are exactly the facts that turn a guessed query
 * into a correct one. Plaid documents roughly eighty personal-finance
 * categories; a given database usually contains a fraction of them, and
 * filtering on one that is absent returns zero rows and looks like an answer.
 *
 * Deliberately describes the VIEWS, never the base tables. The views are the
 * read surface, they are what `costingly_ro` can reach, and they are where the
 * comments live — Postgres does not propagate a table's comments to a view.
 */

import { query } from "./db.js";

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
  rowCount: number;
  columns: ColumnDoc[];
}

/** Facts read from the data, not from the schema. */
export interface LiveFacts {
  /** Oldest and newest transaction date, or null when there are none. */
  dateRange: { first: string; last: string } | null;
  /** The `category` values actually present — usually far fewer than Plaid's. */
  categories: string[];
  accounts: Array<{
    institution: string | null;
    name: string | null;
    mask: string | null;
    type: string | null;
    subtype: string | null;
  }>;
  currencies: string[];
  pendingCount: number;
}

export interface SchemaDoc {
  views: ViewDoc[];
  facts: LiveFacts;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  comment: string | null;
}

/**
 * Build the document.
 *
 * One round trip per concern rather than one giant query — the whole thing runs
 * in a few milliseconds against a personal-sized database, and keeping the
 * queries separate keeps each one readable.
 */
export async function describeSchema(): Promise<SchemaDoc> {
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

  const views: ViewDoc[] = [];
  for (const name of VIEWS) {
    // Not parameterised because the name comes from the constant above, never
    // from a caller.
    const { rows } = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${name}`);
    views.push({
      name,
      comment: commentFor.get(name) ?? null,
      rowCount: Number(rows[0]?.n ?? 0),
      columns: columns
        .filter((c) => c.table_name === name)
        .map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES",
          comment: c.comment,
        })),
    });
  }

  return { views, facts: await readFacts() };
}

async function readFacts(): Promise<LiveFacts> {
  const { rows: span } = await query<{ first: string | null; last: string | null; pending: string }>(`
    SELECT MIN(date)::text AS first,
           MAX(date)::text AS last,
           COUNT(*) FILTER (WHERE pending)::text AS pending
      FROM v_transactions`);

  const { rows: cats } = await query<{ category: string }>(`
    SELECT DISTINCT category FROM v_transactions
     WHERE category IS NOT NULL ORDER BY category`);

  const { rows: curr } = await query<{ currency: string }>(`
    SELECT DISTINCT currency FROM v_transactions
     WHERE currency IS NOT NULL ORDER BY currency`);

  const { rows: accounts } = await query<LiveFacts["accounts"][number]>(`
    SELECT institution_name AS institution, name, mask, type, subtype
      FROM v_accounts ORDER BY institution_name, name`);

  const first = span[0]?.first ?? null;
  const last = span[0]?.last ?? null;

  return {
    dateRange: first !== null && last !== null ? { first, last } : null,
    categories: cats.map((c) => c.category),
    currencies: curr.map((c) => c.currency),
    accounts,
    pendingCount: Number(span[0]?.pending ?? 0),
  };
}

/**
 * Render the document as text.
 *
 * Plain prose rather than JSON: this is written to be *read* — by a person
 * debugging, or by a model deciding what to query — and a wall of nested JSON
 * costs tokens without adding clarity.
 */
export function renderSchemaDoc(doc: SchemaDoc): string {
  const out: string[] = [];
  const { facts } = doc;

  out.push("costingly — local Postgres holding your bank and credit-card transactions.");
  out.push("");
  out.push("Query the v_ views below. The underlying tables are not readable: they hold");
  out.push("encrypted bank credentials and the raw Plaid payloads.");
  out.push("");

  if (facts.dateRange) {
    out.push(
      `Data covers ${facts.dateRange.first} to ${facts.dateRange.last}` +
        (facts.pendingCount > 0 ? `, including ${facts.pendingCount} pending transaction(s).` : "."),
    );
  } else {
    out.push("No transactions yet — run `costingly sync`.");
  }
  out.push("");

  for (const view of doc.views) {
    out.push(`${view.name}  (${view.rowCount.toLocaleString()} rows)`);
    if (view.comment) out.push(indent(view.comment, 2));
    out.push("");
    for (const column of view.columns) {
      out.push(`  ${column.name}  ${column.type}${column.nullable ? "" : " NOT NULL"}`);
      if (column.comment) out.push(indent(column.comment, 6));
    }
    out.push("");
  }

  out.push("VALUES PRESENT IN THIS DATABASE");
  out.push("");
  out.push(`  category (${facts.categories.length}):`);
  out.push(indent(facts.categories.join(", ") || "none", 4));
  out.push("");
  out.push(`  currency: ${facts.currencies.join(", ") || "none"}`);
  out.push("");
  out.push("  accounts:");
  for (const a of facts.accounts) {
    out.push(
      `    ${a.institution ?? "(unknown bank)"} — ${a.name ?? "(unnamed)"}` +
        `${a.mask ? ` ••${a.mask}` : ""}  [${a.type ?? "?"}/${a.subtype ?? "?"}]`,
    );
  }

  return out.join("\n");
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
