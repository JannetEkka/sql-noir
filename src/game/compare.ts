// Grading by evidence. The player's result is compared with the reference
// result row by row, and the verdict carries the rows that prove it: what's
// missing, what shouldn't be there, and which columns didn't line up. The
// model never decides whether an answer is right.

export interface ResultSet {
  columns: string[] | null;
  rows: unknown[][];
}

export type VerdictKind = "correct" | "wrong-columns" | "missing-rows" | "extra-rows" | "wrong-rows" | "wrong-order";

export interface Verdict {
  kind: VerdictKind;
  correct: boolean;
  // Notes that don't change the verdict, e.g. extra columns the case didn't ask for.
  notes: string[];
  evidence: {
    expectedRows: number;
    actualRows: number;
    missing: unknown[][];
    extra: unknown[][];
    // For each expected column, the player's column that matched it, or null.
    columnMatches: { expected: string; actual: string | null }[];
  };
}

const SAMPLE = 5;

// Values that mean the same thing compare equal: 2, 2.0 and "2"; trimmed text;
// numbers to 6 decimal places, so a rounding difference isn't a wrong answer.
export function normalizeValue(value: unknown): string {
  // A control character keeps SQL NULL apart from the text "null".
  if (value === null || value === undefined) return "\u0000NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toFixed(6))) : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(trimmed)) return String(Number(Number(trimmed).toFixed(6)));
    return trimmed;
  }
  return JSON.stringify(value);
}

const rowKey = (row: unknown[]) => JSON.stringify(row.map(normalizeValue));

function columnSignature(rows: unknown[][], index: number): string {
  return rows.map((row) => normalizeValue(row[index])).sort().join("\u0000");
}

function columnName(set: ResultSet, index: number): string {
  return set.columns?.[index] ?? `column ${index + 1}`;
}

const width = (set: ResultSet) => set.columns?.length ?? set.rows[0]?.length ?? 0;

function valueOverlap(expected: ResultSet, e: number, actual: ResultSet, a: number): number {
  const left = new Set(expected.rows.map((row) => normalizeValue(row[e])));
  const right = new Set(actual.rows.map((row) => normalizeValue(row[a])));
  let shared = 0;
  for (const v of left) if (right.has(v)) shared++;
  const union = left.size + right.size - shared;
  return union === 0 ? 1 : shared / union;
}

// Maps each expected column to a player's column, so the player can name
// columns differently or put them in another order. An exact match holds the
// same values; failing that, the column sharing most of its values is used to
// line rows up for the evidence (at least half of the distinct values).
function matchColumns(expected: ResultSet, actual: ResultSet): { index: number | null; exact: boolean }[] {
  const actualWidth = width(actual);
  const used = new Set<number>();
  const matches: { index: number | null; exact: boolean }[] = [];
  for (let e = 0; e < width(expected); e++) {
    const signature = columnSignature(expected.rows, e);
    // Prefer the same position, then any unused column.
    const order = [e, ...Array.from({ length: actualWidth }, (_, i) => i).filter((i) => i !== e)].filter((a) => a < actualWidth && !used.has(a));
    let match: { index: number | null; exact: boolean } = { index: null, exact: false };
    const exact = order.find((a) => columnSignature(actual.rows, a) === signature);
    if (exact !== undefined) {
      match = { index: exact, exact: true };
    } else {
      let best = 0.5;
      for (const a of order) {
        const overlap = valueOverlap(expected, e, actual, a);
        if (overlap >= best) {
          best = overlap;
          match = { index: a, exact: false };
        }
      }
    }
    if (match.index !== null) used.add(match.index);
    matches.push(match);
  }
  return matches;
}

function multisetDiff(left: unknown[][], right: unknown[][]): unknown[][] {
  const counts = new Map<string, number>();
  for (const row of right) counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) + 1);
  const out: unknown[][] = [];
  for (const row of left) {
    const key = rowKey(row);
    const n = counts.get(key) ?? 0;
    if (n > 0) counts.set(key, n - 1);
    else out.push(row);
  }
  return out;
}

export function compareResults(expected: ResultSet, actual: ResultSet, opts: { orderMatters?: boolean } = {}): Verdict {
  const notes: string[] = [];
  const matches = matchColumns(expected, actual);
  const columnMatches = matches.map((m, e) => ({
    expected: columnName(expected, e),
    actual: m.exact && m.index !== null ? columnName(actual, m.index) : null,
  }));
  const base = { expectedRows: expected.rows.length, actualRows: actual.rows.length, columnMatches };

  // Rows are compared through the column mapping. A column with no likely
  // partner is compared by position, so the evidence still shows which rows differ.
  const allExact = matches.every((m) => m.exact);
  const projection = matches.map((m, e) => m.index ?? e);
  const projected = actual.rows.map((row) => projection.map((i) => row[i]));
  const missing = multisetDiff(expected.rows, projected);
  const extra = multisetDiff(projected, expected.rows);

  if (missing.length === 0 && extra.length === 0) {
    const actualWidth = width(actual);
    if (actualWidth > projection.length) notes.push(`Your result has ${actualWidth - projection.length} more column(s) than the case asked for. That's fine.`);
    if (opts.orderMatters && expected.rows.some((row, i) => rowKey(row) !== rowKey(projected[i] ?? []))) {
      return { kind: "wrong-order", correct: false, notes, evidence: { ...base, missing: [], extra: [] } };
    }
    return { kind: "correct", correct: true, notes, evidence: { ...base, missing: [], extra: [] } };
  }

  const evidence = { ...base, missing: missing.slice(0, SAMPLE), extra: extra.slice(0, SAMPLE) };
  if (!allExact && expected.rows.length === actual.rows.length) return { kind: "wrong-columns", correct: false, notes, evidence };
  if (missing.length && !extra.length) return { kind: "missing-rows", correct: false, notes, evidence };
  if (extra.length && !missing.length) return { kind: "extra-rows", correct: false, notes, evidence };
  return { kind: "wrong-rows", correct: false, notes, evidence };
}

// One plain sentence for the player, built only from the evidence.
export function describeVerdict(v: Verdict): string {
  const { expectedRows, actualRows, missing, extra, columnMatches } = v.evidence;
  switch (v.kind) {
    case "correct":
      return "Case closed: your result matches the evidence.";
    case "wrong-order":
      return "The right rows, in the wrong order. The case asks for them sorted.";
    case "wrong-columns": {
      const unmatched = columnMatches.filter((c) => c.actual === null).map((c) => c.expected);
      return `The right number of rows, but no column of yours holds the values for: ${unmatched.join(", ")}.`;
    }
    case "missing-rows":
      return `You found ${actualRows} of ${expectedRows} rows. ${missing.length} expected row(s) are missing from your result.`;
    case "extra-rows":
      return `Your result has ${actualRows - expectedRows} row(s) the case doesn't include. Something in your filter lets too much through.`;
    case "wrong-rows":
      return `Some of your rows don't match: ${missing.length} expected row(s) are missing and ${extra.length} of yours shouldn't be there.`;
  }
}
