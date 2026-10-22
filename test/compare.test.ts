import { test } from "node:test";
import assert from "node:assert/strict";
import { compareResults, describeVerdict, normalizeValue } from "../src/game/compare.ts";

const expected = {
  columns: ["store_name", "returns"],
  rows: [
    ["ation", 120],
    ["bar", 95],
    ["eing", 40],
  ],
};

test("values that mean the same compare equal", () => {
  assert.equal(normalizeValue(2), normalizeValue("2.0"));
  assert.equal(normalizeValue(" ought "), "ought");
  assert.equal(normalizeValue(0.1 + 0.2), normalizeValue(0.3));
  assert.notEqual(normalizeValue(null), normalizeValue("null "));
});

test("the same rows in another order, with renamed columns, is correct", () => {
  const actual = { columns: ["returns_count", "name"], rows: [[40, "eing"], [120, "ation"], [95, "bar"]] };
  const v = compareResults(expected, actual);
  assert.equal(v.kind, "correct");
  assert.deepEqual(v.evidence.columnMatches, [
    { expected: "store_name", actual: "name" },
    { expected: "returns", actual: "returns_count" },
  ]);
});

test("extra columns are fine, and noted", () => {
  const actual = { columns: ["s_store_sk", "store_name", "returns"], rows: [[1, "ation", 120], [2, "bar", 95], [3, "eing", 40]] };
  const v = compareResults(expected, actual);
  assert.equal(v.kind, "correct");
  assert.match(v.notes[0], /1 more column/);
});

test("order only counts when the case says so", () => {
  const actual = { columns: ["store_name", "returns"], rows: [["bar", 95], ["ation", 120], ["eing", 40]] };
  assert.equal(compareResults(expected, actual).kind, "correct");
  assert.equal(compareResults(expected, actual, { orderMatters: true }).kind, "wrong-order");
});

test("a missing row is named in the evidence", () => {
  const actual = { columns: ["store_name", "returns"], rows: [["ation", 120], ["bar", 95]] };
  const v = compareResults(expected, actual);
  assert.equal(v.kind, "missing-rows");
  assert.deepEqual(v.evidence.missing, [["eing", 40]]);
  assert.equal(describeVerdict(v), "You found 2 of 3 rows. 1 expected row(s) are missing from your result.");
});

test("rows that shouldn't be there are named, even with columns reordered", () => {
  const actual = { columns: ["returns", "store_name"], rows: [[120, "ation"], [95, "bar"], [40, "eing"], [7, "able"]] };
  const v = compareResults(expected, actual);
  assert.equal(v.kind, "extra-rows");
  assert.deepEqual(v.evidence.extra, [["able", 7]]);
});

test("a column with the wrong values is pointed at", () => {
  const actual = { columns: ["store_name", "returns"], rows: [["ation", 12], ["bar", 9], ["eing", 4]] };
  const v = compareResults(expected, actual);
  assert.equal(v.kind, "wrong-columns");
  assert.deepEqual(v.evidence.columnMatches.find((c) => c.expected === "returns"), { expected: "returns", actual: null });
  assert.match(describeVerdict(v), /returns/);
  assert.equal(v.evidence.missing.length, 3);
});

test("right values paired with the wrong names is wrong rows", () => {
  const actual = { columns: ["store_name", "returns"], rows: [["ation", 95], ["bar", 120], ["eing", 40]] };
  const v = compareResults(expected, actual);
  assert.equal(v.kind, "wrong-rows");
  assert.deepEqual(v.evidence.missing, [["ation", 120], ["bar", 95]]);
});

test("duplicates count: the same row twice is not the same as once", () => {
  const once = { columns: ["x"], rows: [["a"]] };
  const twice = { columns: ["x"], rows: [["a"], ["a"]] };
  assert.equal(compareResults(once, twice).kind, "extra-rows");
});
