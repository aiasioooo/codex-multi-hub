import assert from "node:assert/strict";
import test from "node:test";
import { buildObserverState } from "../src/observer.mjs";

test("observer derives quota, pinned intermediator, and relay activity", () => {
  const now = new Date().toISOString();
  const result = buildObserverState({
    instances: {
      zxc: {
        connected: true,
        error: null,
        port: 1234,
        updatedAt: now,
        threads: [
          { id: "normal", preview: "Normal task", status: { type: "active" }, updatedAt: 10 },
          { id: "middle", name: "Hub Intermediator — zxc", preview: "", status: { type: "idle" }, updatedAt: 1, runtime: { model: "gpt-test", effort: "low" } },
        ],
      },
    },
    intermediators: [{ instance: "zxc", threadId: "middle" }],
    messages: [{ id: "message", createdAt: now, updatedAt: now, fromInstance: "zxc", toInstance: "aiasio", toThreadId: "target", state: "queued", body: "Continue" }],
    events: [{ id: 1, createdAt: now, instance: "zxc", type: "account/rateLimits/updated", payload: { rateLimits: { primary: { usedPercent: 35, resetsAt: 2_000_000_000 }, planType: "plus" } } }],
  });

  assert.equal(result.instances.zxc.rateLimit.remainingPercent, 65);
  assert.equal(result.instances.zxc.rateLimitTelemetry.state, "live");
  assert.equal(result.instances.zxc.activeCount, 1);
  assert.equal(result.instances.zxc.tasks[0].id, "middle");
  assert.equal(result.instances.zxc.tasks[0].model, "gpt-test");
  assert.equal(result.activity[0].title, "zxc → aiasio");
});

test("observer prefers actively read quota data and preserves a secondary window", () => {
  const now = new Date().toISOString();
  const result = buildObserverState({
    instances: {
      zxc: {
        connected: true,
        error: null,
        port: 1234,
        updatedAt: now,
        threads: [],
        rateLimits: {
          primary: { usedPercent: 58, resetsAt: 2_000_000_000, windowDurationMins: 10_080 },
          secondary: { usedPercent: 20, resetsAt: 2_000_000_100, windowDurationMins: 300 },
          planType: "plus",
        },
        rateLimitsObservedAt: now,
      },
    },
    intermediators: [],
    messages: [],
    events: [{ id: 1, createdAt: "2020-01-01T00:00:00.000Z", instance: "zxc", type: "account/rateLimits/updated", payload: { rateLimits: { primary: { usedPercent: 35 } } } }],
  });

  assert.equal(result.instances.zxc.rateLimit.remainingPercent, 42);
  assert.equal(result.instances.zxc.rateLimit.secondary.remainingPercent, 80);
  assert.equal(result.instances.zxc.rateLimit.secondary.windowMinutes, 300);
  assert.equal(result.instances.zxc.rateLimit.observedAt, now);
  assert.equal(result.instances.zxc.rateLimitTelemetry.state, "live");
});

test("observer marks cached quota as authentication-blocked instead of live", () => {
  const observedAt = "2026-07-13T00:00:00.000Z";
  const result = buildObserverState({
    instances: {
      zxc: {
        connected: true,
        error: null,
        port: 1234,
        updatedAt: observedAt,
        threads: [],
        rateLimits: { primary: { usedPercent: 55, windowDurationMins: 10_080 } },
        rateLimitsObservedAt: observedAt,
        rateLimitError: "401 Unauthorized: authentication token has been invalidated",
      },
    },
    intermediators: [],
    messages: [],
    events: [],
  });

  assert.equal(result.instances.zxc.rateLimit.remainingPercent, 45);
  assert.equal(result.instances.zxc.rateLimitTelemetry.state, "auth-required");
  assert.equal(result.instances.zxc.rateLimitTelemetry.observedAt, observedAt);
});

test("observer marks persistent host tasks and exposes live presentation state", () => {
  const now = new Date().toISOString();
  const result = buildObserverState({
    instances: {
      zxc: {
        connected: true,
        error: null,
        port: 1234,
        updatedAt: now,
        threads: [{ id: "host-z", name: "Nacchan Host — zxc", status: { type: "idle" }, updatedAt: Date.now() }],
      },
    },
    intermediators: [],
    messages: [
      { id: "host-message", createdAt: now, updatedAt: now, kind: "host conversation", state: "delivered", fromInstance: "zxc", fromThreadId: "host-z", toInstance: "aiasio", toThreadId: "host-a", body: "The relay has a new name." },
      { id: "setup", createdAt: now, updatedAt: now, kind: "followup task", state: "delivered", fromInstance: "gui", toInstance: "zxc", toThreadId: "host-z", reason: "install persistent host automation context", body: "Your host automation is now installed." },
      { id: "legacy-peer-activation", createdAt: now, updatedAt: now, kind: "host conversation", state: "delivered", fromInstance: "zxc", toInstance: "aiasio", toThreadId: "host-a", reason: "live manual host exchange", body: "[Live host session host-example]\nKind: manual\nTurns remaining: 3\n\nA private activation prompt." },
      { id: "wake", createdAt: now, updatedAt: now, kind: "followup task", state: "delivered", fromInstance: "gui", toInstance: "zxc", toThreadId: "host-z", reason: "manual persistent host wake", body: "[Host wake manual_zxc]\nmanual · now" },
      { id: "canceled", createdAt: now, updatedAt: now, kind: "message", state: "canceled", fromInstance: "zxc", toInstance: "aiasio", toThreadId: "target", body: "Obsolete." },
      { id: "operator-note", createdAt: now, updatedAt: now, kind: "message", state: "delivered", fromInstance: "gui", toInstance: "zxc", toThreadId: "host-z", body: "Operational note." },
    ],
    events: [],
    hosts: [{ instance: "zxc", threadId: "host-z", model: "gpt-5.6-sol", reasoningEffort: "low" }],
    hostSessions: [{ id: "session-1", kind: "ambient", state: "active" }],
    hostActions: [{ id: "speech-1", instance: "zxc", type: "speech", text: "Hello", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    hostResearch: [{ id: "research-1", instance: "zxc", type: "research", text: "A current fact", createdAt: now, payload: { title: "Signal found", sources: [{ title: "Source", url: "https://example.com" }] } }],
    hostJournal: [
      { id: 4, instance: "zxc", sessionId: "session-1", kind: "dialogue", text: "Observe.", createdAt: now, metadata: { tone: "smug" } },
      { id: 5, instance: "zxc", sessionId: "session-1", kind: "visual", text: "activity.timeline: SAME TOPIC", createdAt: now, metadata: {} },
    ],
  });

  assert.equal(result.instances.zxc.tasks[0].host, true);
  assert.equal(result.instances.zxc.host.available, true);
  assert.equal(result.activeHostSession.id, "session-1");
  assert.equal(result.hostActions[0].text, "Hello");
  assert.equal(result.activity.filter((item) => item.kind === "host-chat").length, 2);
  assert.equal(result.activity.find((item) => item.messageId === "host-message").summary, "The relay has a new name.");
  assert.equal(result.activity.some((item) => item.messageId === "setup"), false);
  assert.equal(result.activity.some((item) => item.messageId === "legacy-peer-activation"), false);
  assert.equal(result.activity.some((item) => item.messageId === "wake"), false);
  assert.equal(result.activity.some((item) => item.messageId === "canceled"), false);
  assert.equal(result.activity.find((item) => item.messageId === "operator-note").kind, "communication");
  assert.equal(result.activity.find((item) => item.id === "host-journal:4").tone, "smug");
  assert.equal(result.activity.some((item) => item.id === "host-journal:5"), false);
  assert.equal(result.activity.find((item) => item.kind === "host-research").sources[0].url, "https://example.com");
});
