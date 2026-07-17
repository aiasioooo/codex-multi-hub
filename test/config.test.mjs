import test from "node:test";
import assert from "node:assert/strict";
import { assertHubSource, assertInstance, hubSourceNames, instanceNames } from "../src/config.mjs";

test("operator instances remain limited to the two account homes", () => {
  assert.deepEqual(instanceNames, ["zxc", "aiasio"]);
  assert.equal(assertInstance("zxc"), "zxc");
  assert.equal(assertInstance("aiasio"), "aiasio");
  assert.throws(() => assertInstance("gui"), /Expected zxc or aiasio/);
});

test("hub sources include the neutral GUI coordinator", () => {
  assert.deepEqual(hubSourceNames, ["zxc", "aiasio", "gui"]);
  assert.equal(assertHubSource("gui"), "gui");
  assert.equal(assertHubSource("zxc"), "zxc");
  assert.throws(() => assertHubSource("unknown"), /Expected zxc, aiasio, or gui/);
});
