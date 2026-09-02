/**
 * Rendering the schema document as the text a model reads.
 *
 * Sits beside the tool rather than in data/: how a schema is *described* to a
 * model is a protocol decision, and the same document could be rendered
 * differently for a different surface. The repository builds the facts; this
 * decides how they read.
 */

import type { DatabaseDoc } from "../../../domain/data/repositories/schema.repository.js";

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
