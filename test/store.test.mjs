import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HubStore } from "../src/store.mjs";

test("message queue persists delivery state and priority order", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hub-store-"));
  const store = new HubStore(path.join(directory, "test.sqlite"));
  try {
    store.createMessage({
      id: "normal",
      fromInstance: "zxc",
      toInstance: "aiasio",
      toThreadId: "thread-1",
      body: "normal note",
      priority: "normal",
    });
    store.createMessage({
      id: "urgent",
      fromInstance: "zxc",
      toInstance: "aiasio",
      toThreadId: "thread-1",
      body: "urgent note",
      priority: "urgent",
    });

    assert.deepEqual(store.queuedMessages("aiasio", "thread-1").map((message) => message.id), ["urgent", "normal"]);
    store.updateMessage("urgent", "delivered", { turnId: "turn-1" });
    assert.equal(store.getMessage("urgent").state, "delivered");
    assert.equal(store.getMessage("urgent").deliveredTurnId, "turn-1");
    assert.deepEqual(store.queuedMessages("aiasio", "thread-1").map((message) => message.id), ["normal"]);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("events retain structured native protocol payloads", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hub-events-"));
  const store = new HubStore(path.join(directory, "test.sqlite"));
  try {
    store.addEvent({
      instance: "aiasio",
      type: "turn/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { turn: { status: "completed" } },
    });
    const [event] = store.listEvents(1);
    assert.equal(event.type, "turn/completed");
    assert.deepEqual(event.payload, { turn: { status: "completed" } });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("intermediator binding is unique per instance and replaceable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hub-intermediator-"));
  const store = new HubStore(path.join(directory, "test.sqlite"));
  try {
    store.setIntermediator({ instance: "zxc", threadId: "thread-a", model: "model-a", reasoningEffort: "high" });
    store.setIntermediator({ instance: "zxc", threadId: "thread-b", model: "model-b", reasoningEffort: "medium" });
    const binding = store.getIntermediator("zxc");
    assert.equal(binding.threadId, "thread-b");
    assert.equal(binding.model, "model-b");
    assert.equal(store.listIntermediators().length, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("host identity, legacy session history, actions, and continuity persist independently of a thread", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hub-host-"));
  const store = new HubStore(path.join(directory, "test.sqlite"));
  try {
    store.setHost({ instance: "zxc", threadId: "host-a", model: "gpt-5.6-sol", reasoningEffort: "low" });
    store.setHost({ instance: "zxc", threadId: "host-b", model: "gpt-5.6-sol", reasoningEffort: "low", personaVersion: 2 });
    assert.equal(store.getHost("zxc").threadId, "host-b");
    assert.equal(store.getHost("zxc").personaVersion, 2);

    const session = store.createHostSession({
      id: "session-1",
      kind: "ambient",
      initiator: "zxc",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxTurns: 2,
      maxSearches: 1,
    });
    assert.equal(session.turnsUsed, 0);
    assert.equal(store.reserveHostTurn("session-1").turnsUsed, 1);
    assert.equal(store.reserveHostTurn("session-1").turnsUsed, 2);
    assert.equal(store.reserveHostTurn("session-1"), null);
    assert.equal(store.reserveHostSearch("session-1").searchesUsed, 1);
    assert.equal(store.reserveHostSearch("session-1"), null);

    store.createHostAction({
      id: "action-1",
      sessionId: "session-1",
      instance: "zxc",
      type: "callout",
      target: "operator.zxc.quota",
      text: "Plenty.",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(store.listActiveHostActions().length, 1);
    store.expireHostActions({ sessionId: "session-1" });
    assert.equal(store.listActiveHostActions().length, 0);

    store.addHostJournal({ instance: "zxc", sessionId: "session-1", kind: "callback", text: "Free space may reproduce." });
    assert.equal(store.listHostJournal({ instance: "zxc" })[0].text, "Free space may reproduce.");
    store.setRuntimeState("host:ambient:next", "later");
    assert.equal(store.getRuntimeState("host:ambient:next").value, "later");
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
