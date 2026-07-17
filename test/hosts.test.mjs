import assert from "node:assert/strict";
import test from "node:test";
import { buildHostWake } from "../src/host-automation.mjs";

test("host wake envelope contains only identity, kind, and local time", () => {
  const body = buildHostWake("ambient", "zxc", new Date("2026-07-16T18:30:00.000Z"));
  const lines = body.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "[Host wake ambient_zxc]");
  assert.match(lines[1], /^ambient · \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
  assert.doesNotMatch(body, /turn|web|quota|viewer|observe|rule|seed|session/i);
});
