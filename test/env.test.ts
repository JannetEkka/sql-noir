import { test } from "node:test";
import assert from "node:assert/strict";
import { record } from "../scripts/env.ts";

test("a recording that contains a secret from .env is never written", () => {
  process.env.ZETARIS_API_KEY = "zk-secret-value-123";
  try {
    assert.equal(record("should-not-exist", { echoed: "Bearer zk-secret-value-123" }), null);
  } finally {
    delete process.env.ZETARIS_API_KEY;
  }
});
