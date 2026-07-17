import assert from "node:assert/strict";
import test from "node:test";
import { messageEnvelope } from "../src/hub.mjs";

test("host messages do not get a second relay envelope", () => {
  const message = {
    id: "task_example",
    kind: "host ambient activation",
    fromInstance: "aiasio",
    reason: "occasional unscripted lounge session",
    body: "[Host ambient host_example]\ncompact body",
  };
  assert.equal(messageEnvelope(message), message.body);
});

test("ordinary messages retain relay provenance", () => {
  const body = messageEnvelope({
    id: "task_example",
    kind: "followup task",
    fromInstance: "gui",
    reason: "user request",
    body: "Inspect this.",
  });
  assert.match(body, /\[Hub followup task from gui\]/);
  assert.match(body, /Message ID: task_example/);
  assert.match(body, /Reason: user request/);
});
