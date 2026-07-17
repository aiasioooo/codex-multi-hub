import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { accountHome, assertHubSource, assertInstance, instanceNames, operatorName, remoteStatePath } from "./config.mjs";
import { CodexAppServerClient } from "./codex-client.mjs";
import { HubStore } from "./store.mjs";
import { buildObserverState } from "./observer.mjs";
import { HostDirector } from "./hosts.mjs";

const SENSITIVE_PATH = /(^|[\\/])(auth\.json|\.credentials\.json|.*(?:credential|secret|token|private[_-]?key).*)$/i;
const INTERMEDIATOR_ROLE_VERSION = 2;

function mergeSparseRateLimits(current = {}, update = {}) {
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(update || {})) {
    if (value == null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      merged[key] = mergeSparseRateLimits(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function intermediatorInstructions(instance) {
  return [
    `You are the persistent Hub Intermediator for ${operatorName(instance)} (internal instance key: ${instance}).`,
    "Coordinate requests that cross Codex account boundaries and use your judgment to ask, route, delegate, queue, steer, interrupt, or hand off work.",
    "Prefer native Codex task coordination for work inside this instance and explicit codex_multi_hub tools for the other instance.",
    "The official Codex desktop app is the user's canonical interactive surface; the Codex Multi Hub browser dashboard is observation-only. The desktop app is not a third hub instance, and a GUI task may belong to a different CODEX_HOME or remote connection, so confirm its instance identity before acting.",
    "Interact with GUI-visible work through semantic Codex task/thread operations exposed in your runtime: discover or read tasks, create or continue work, send or steer input, and prepare handoffs. If no semantic operation reaches the requested GUI task, say so and use a hub message or a workspace handoff; shell access and process inspection are not a semantic GUI task API.",
    "Use direct GUI or computer automation only when the user explicitly asks for a UI action and an appropriate tool is actually available. Treat the desktop app, the two account app-servers, and the hub supervisor as separate processes; never stop, restart, kill, or relaunch the desktop app as part of hub maintenance.",
    "Never inspect or transmit authentication, credential, token, or secret material from the desktop app's Codex home or either account home.",
    "Do not become a required control plane: direct hub thread and messaging tools remain valid, and durable facts belong in the hub event/message store or the workspace rather than only in this conversation.",
    "When asked to create specialized work, honor the requested model and reasoning effort when the available task tools support them, and report resulting task IDs clearly.",
    "Keep coordination responses concise and avoid reciprocal message loops without progress.",
  ].join("\n");
}

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function threadStatusType(thread) {
  return thread?.status?.type || thread?.status || "unknown";
}

function activeTurn(thread) {
  const turns = thread?.turns || [];
  return turns.find((turn) => ["inProgress", "running"].includes(turn.status?.type || turn.status)) || null;
}

export function messageEnvelope(message) {
  // Host turns already carry a bounded session envelope. Re-wrapping them with
  // relay bookkeeping wastes context and exposes IDs the host cannot use.
  if (String(message.kind || "").startsWith("host ")) return message.body;
  const from = message.fromThreadId ? `${message.fromInstance}/${message.fromThreadId}` : message.fromInstance;
  return [
    `[Hub ${message.kind} from ${from}]`,
    `Message ID: ${message.id}`,
    message.reason ? `Reason: ${message.reason}` : null,
    "",
    message.body,
  ].filter((line) => line !== null).join("\n");
}

function extractConversation(thread, maxChars = 24_000) {
  const lines = [];
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const text = item.text || item.content?.map((part) => part.text || "").join("\n");
        if (text) lines.push(`USER: ${text}`);
      } else if (item.type === "agentMessage") {
        const text = item.text || item.content?.map((part) => part.text || "").join("\n");
        if (text) lines.push(`ASSISTANT: ${text}`);
      }
    }
  }
  const joined = lines.join("\n\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

export class CodexHub extends EventEmitter {
  constructor({ store = new HubStore(), pollIntervalMs = 2_500, rateLimitPollIntervalMs = 30_000 } = {}) {
    super();
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.rateLimitPollIntervalMs = rateLimitPollIntervalMs;
    this.clients = new Map();
    this.failoverDepthByThread = new Map();
    this.handledQuotaFailures = new Set();
    this.intermediatorPromises = new Map();
    this.hostDirector = new HostDirector(this);
    this.runtimeCache = new Map();
    this.acceptingWork = true;
    this.instances = Object.fromEntries(instanceNames.map((name) => [name, {
      name,
      connected: false,
      error: null,
      port: null,
      threads: [],
      updatedAt: null,
      rateLimits: null,
      rateLimitsObservedAt: null,
      rateLimitError: null,
      lastRateLimitReadAt: 0,
    }]));
    this.pollTimer = null;
  }

  async start() {
    this.acceptingWork = true;
    await Promise.allSettled(instanceNames.map((name) => this.#ensureClient(name)));
    await this.poll();
    await Promise.allSettled(instanceNames.map((name) => this.ensureIntermediator(name)));
    await this.hostDirector.start();
    this.pollTimer = setInterval(() => this.poll().catch((error) => this.emit("error", error)), this.pollIntervalMs);
  }

  async stop() {
    clearInterval(this.pollTimer);
    this.hostDirector.stop();
    for (const client of this.clients.values()) client.close();
    this.store.close();
  }

  setAcceptingWork(value) {
    this.acceptingWork = Boolean(value);
  }

  async poll() {
    await Promise.allSettled(instanceNames.map(async (name) => {
      const client = await this.#ensureClient(name);
      if (!client?.connected) return;
      try {
        await this.#refreshRateLimits(name, client);
        const result = await client.rpc("thread/list", {
          limit: 40,
          sortKey: "recency_at",
          sortDirection: "desc",
          useStateDbOnly: false,
        }, 20_000);
        this.instances[name].threads = (result.data || []).map((thread) => this.#enrichThread(thread));
        this.instances[name].connected = true;
        this.instances[name].error = null;
        this.instances[name].updatedAt = new Date().toISOString();
        if (this.acceptingWork) await this.#flushQueues(name);
      } catch (error) {
        this.instances[name].error = error.message;
      }
    }));
    this.emit("state");
  }

  snapshot() {
    const hosts = this.hostDirector.snapshot();
    return buildObserverState({
      instances: this.instances,
      intermediators: this.store.listIntermediators(),
      messages: this.store.listMessages({ limit: 150 }),
      events: this.store.listEvents(300),
      hosts: hosts.bindings,
      hostSessions: hosts.sessions,
      hostActions: hosts.actions,
      hostResearch: hosts.research,
      hostJournal: hosts.journal,
      hostSchedule: hosts.schedule,
      viewerLastSeenAt: hosts.viewerLastSeenAt,
    });
  }

  ensureHost(instance, options = {}) {
    return this.hostDirector.ensureHost(instance, options);
  }

  listHosts() {
    return this.hostDirector.listHosts();
  }

  hostObserve(instance, sourceThreadId) {
    return this.hostDirector.observe(instance, sourceThreadId);
  }

  hostSay(args) {
    return this.hostDirector.say(args);
  }

  hostCallout(args) {
    return this.hostDirector.callout(args);
  }

  hostHighlight(args) {
    return this.hostDirector.highlight(args);
  }

  hostCamera(args) {
    return this.hostDirector.camera(args);
  }

  hostContact(args) {
    return this.hostDirector.contact(args);
  }

  hostRemember(args) {
    return this.hostDirector.remember(args);
  }

  hostResearch(args) {
    return this.hostDirector.research(args);
  }

  markViewerPresent() {
    return this.hostDirector.markViewerPresent();
  }

  async listThreads(instance, limit = 30) {
    if (instance) {
      assertInstance(instance);
      const client = await this.#requiredClient(instance);
      return ((await client.rpc("thread/list", {
        limit,
        sortKey: "recency_at",
        sortDirection: "desc",
        useStateDbOnly: false,
      })).data || []).map((thread) => this.#enrichThread(thread));
    }
    const result = {};
    for (const name of instanceNames) result[name] = await this.listThreads(name, limit);
    return result;
  }

  async listModels(instance, includeHidden = false, limit = 100) {
    assertInstance(instance);
    const client = await this.#requiredClient(instance);
    const result = await client.rpc("model/list", { includeHidden, limit });
    return result.data || [];
  }

  async readThread(instance, threadId, includeTurns = true) {
    assertInstance(instance);
    const client = await this.#requiredClient(instance);
    try {
      const result = await client.rpc("thread/read", { threadId, includeTurns });
      return this.#enrichThread(result.thread || result);
    } catch (error) {
      if (!includeTurns || !error.message.includes("ephemeral threads do not support includeTurns")) throw error;
      const result = await client.rpc("thread/read", { threadId, includeTurns: false });
      return this.#enrichThread(result.thread || result);
    }
  }

  async archiveThread(instance, threadId) {
    assertInstance(instance);
    const client = await this.#requiredClient(instance);
    const result = await client.rpc("thread/archive", { threadId });
    this.store.addEvent({ instance, type: "hub.thread.archived", threadId, payload: { reason: "replaced persistent role binding" } });
    return result;
  }

  async inspectThread(instance, threadId) {
    const thread = await this.readThread(instance, threadId, true);
    return {
      thread,
      messages: this.store.listRelatedMessages(instance, threadId, 80),
      events: this.store.listThreadEvents(instance, threadId, 120),
    };
  }

  async startThread(instance, {
    message = null,
    cwd = null,
    ephemeral = false,
    model = null,
    reasoningEffort = null,
    name = null,
    developerInstructions = null,
  } = {}) {
    assertInstance(instance);
    const client = await this.#requiredClient(instance);
    const result = await client.rpc("thread/start", {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { config: { model_reasoning_effort: reasoningEffort } } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      ephemeral,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      threadSource: "appServer",
    });
    const thread = result.thread || result;
    if (name) await client.rpc("thread/name/set", { threadId: thread.id, name });
    this.store.addEvent({
      instance,
      type: "hub.thread.started",
      threadId: thread.id,
      payload: { cwd, ephemeral, model, reasoningEffort, name },
    });
    if (message) {
      const turnResult = await client.rpc("turn/start", {
        threadId: thread.id,
        input: textInput(message),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      return { thread, turn: turnResult.turn || turnResult };
    }
    return { thread };
  }

  async forkThread(instance, threadId, {
    message = null,
    cwd = null,
    ephemeral = false,
    model = null,
    reasoningEffort = null,
  } = {}) {
    assertInstance(instance);
    const client = await this.#requiredClient(instance);
    const result = await client.rpc("thread/fork", {
      threadId,
      ephemeral,
      ...(cwd ? { cwd } : {}),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      threadSource: "appServer",
    });
    const thread = result.thread || result;
    if (message) {
      const turnResult = await client.rpc("turn/start", {
        threadId: thread.id,
        input: textInput(message),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      return { thread, turn: turnResult.turn || turnResult };
    }
    return { thread };
  }

  async reloadMcp(instance) {
    assertInstance(instance);
    const client = await this.#requiredClient(instance);
    const result = await client.rpc("config/mcpServer/reload", {});
    this.store.addEvent({ instance, type: "hub.mcp.reloaded", payload: {} });
    return result;
  }

  async ensureIntermediator(instance, {
    model = null,
    reasoningEffort = null,
    recreate = false,
  } = {}) {
    assertInstance(instance);
    if (this.intermediatorPromises.has(instance)) return this.intermediatorPromises.get(instance);
    const promise = this.#ensureIntermediator(instance, { model, reasoningEffort, recreate });
    this.intermediatorPromises.set(instance, promise);
    try {
      return await promise;
    } finally {
      this.intermediatorPromises.delete(instance);
    }
  }

  async listIntermediators() {
    const result = {};
    for (const instance of instanceNames) {
      const binding = this.store.getIntermediator(instance);
      if (!binding) {
        result[instance] = { instance, available: false, error: "Not created yet" };
        continue;
      }
      try {
        const thread = await this.readThread(instance, binding.threadId, false);
        result[instance] = {
          ...binding,
          available: true,
          status: threadStatusType(thread),
          name: thread.name || null,
        };
      } catch (error) {
        result[instance] = { ...binding, available: false, error: error.message };
      }
    }
    return result;
  }

  async askIntermediator({
    fromInstance,
    fromThreadId = null,
    toInstance,
    body,
    reason = null,
    priority = "normal",
    model = null,
    reasoningEffort = null,
  }) {
    assertHubSource(fromInstance);
    assertInstance(toInstance);
    const intermediator = await this.ensureIntermediator(toInstance);
    const message = await this.followupTask({
      fromInstance,
      fromThreadId,
      toInstance,
      toThreadId: intermediator.threadId,
      body,
      reason: reason || "request for persistent hub intermediator",
      priority,
      model: model || intermediator.model,
      reasoningEffort: reasoningEffort || intermediator.reasoningEffort,
      kind: "intermediator request",
    });
    return { intermediator, message };
  }

  async sendMessage({ fromInstance, fromThreadId = null, toInstance, toThreadId, body, reason = null, priority = "normal" }) {
    assertHubSource(fromInstance);
    assertInstance(toInstance);
    const message = this.store.createMessage({
      id: `msg_${crypto.randomUUID()}`,
      fromInstance,
      fromThreadId,
      toInstance,
      toThreadId,
      kind: "message",
      body,
      reason,
      priority,
      triggerTurn: true,
      state: "queued",
    });
    await this.#deliver(message, true);
    return this.store.getMessage(message.id);
  }

  async leaveNote({ fromInstance, fromThreadId = null, toInstance, toThreadId, body, reason = null, priority = "normal" }) {
    assertHubSource(fromInstance);
    assertInstance(toInstance);
    const message = this.store.createMessage({
      id: `note_${crypto.randomUUID()}`,
      fromInstance,
      fromThreadId,
      toInstance,
      toThreadId,
      kind: "note",
      body,
      reason,
      priority,
      triggerTurn: false,
      state: "queued",
    });
    await this.#deliver(message, false);
    return this.store.getMessage(message.id);
  }

  cancelMessage(fromInstance, messageId, reason = null) {
    assertHubSource(fromInstance);
    const message = this.store.getMessage(messageId);
    if (!message) throw new Error(`Hub message ${messageId} does not exist`);
    if (message.state !== "queued") throw new Error(`Only queued messages can be canceled; ${messageId} is ${message.state}`);
    const canceled = this.store.updateMessage(messageId, "canceled", { error: reason || `Canceled by ${fromInstance}` });
    this.store.addEvent({
      instance: message.toInstance,
      type: "hub.message.canceled",
      threadId: message.toThreadId,
      payload: { messageId, byInstance: fromInstance, reason },
    });
    return canceled;
  }

  async followupTask({
    fromInstance,
    fromThreadId = null,
    toInstance,
    toThreadId = null,
    body,
    reason = null,
    priority = "normal",
    cwd = null,
    model = null,
    reasoningEffort = null,
    kind = "followup task",
  }) {
    assertHubSource(fromInstance);
    assertInstance(toInstance);
    if (!toThreadId) {
      const started = await this.startThread(toInstance, { cwd, model, reasoningEffort });
      toThreadId = started.thread.id;
    }
    const message = this.store.createMessage({
      id: `task_${crypto.randomUUID()}`,
      fromInstance,
      fromThreadId,
      toInstance,
      toThreadId,
      kind,
      body,
      reason,
      priority,
      triggerTurn: true,
      state: "queued",
      metadata: { model, reasoningEffort },
    });
    await this.#deliver(message, true);
    return this.store.getMessage(message.id);
  }

  async steerThread({ fromInstance, toInstance, threadId, body, reason = null, queueIfIdle = true }) {
    assertHubSource(fromInstance);
    assertInstance(toInstance);
    const message = this.store.createMessage({
      id: `steer_${crypto.randomUUID()}`,
      fromInstance,
      toInstance,
      toThreadId: threadId,
      kind: "steer",
      body,
      reason,
      priority: "high",
      triggerTurn: false,
      state: "queued",
    });
    const delivered = await this.#deliver(message, false);
    if (!delivered && !queueIfIdle) {
      this.store.updateMessage(message.id, "failed", { error: "Target thread is idle" });
    }
    return this.store.getMessage(message.id);
  }

  async interruptThread({ fromInstance, toInstance, threadId, reason = null }) {
    assertHubSource(fromInstance);
    assertInstance(toInstance);
    const client = await this.#requiredClient(toInstance);
    const thread = await this.readThread(toInstance, threadId, true);
    const turn = activeTurn(thread);
    if (!turn) throw new Error(`Thread ${threadId} is not running`);
    const result = await client.rpc("turn/interrupt", { threadId, turnId: turn.id });
    this.store.addEvent({
      instance: toInstance,
      type: "hub.thread.interrupted",
      threadId,
      turnId: turn.id,
      payload: { fromInstance, reason },
    });
    return result;
  }

  async prepareHandoff({ fromInstance, fromThreadId, toInstance, toThreadId = null, instruction, cwd = null }) {
    assertHubSource(fromInstance);
    assertInstance(toInstance);
    let source;
    try {
      source = await this.readThread(fromInstance, fromThreadId, true);
    } catch (error) {
      source = { id: fromThreadId, error: error.message, turns: [] };
    }
    const conversation = extractConversation(source);
    const workspace = cwd || source.cwd || null;
    let git = null;
    if (workspace && fs.existsSync(path.join(workspace, ".git"))) {
      try {
        git = {
          status: execFileSync("git", ["status", "--short"], { cwd: workspace, encoding: "utf8", timeout: 10_000 }),
          diffStat: execFileSync("git", ["diff", "--stat"], { cwd: workspace, encoding: "utf8", timeout: 10_000 }),
        };
      } catch (error) {
        git = { error: error.message };
      }
    }
    const body = [
      "Continue this task from the other Codex instance.",
      `Source instance: ${fromInstance}`,
      `Source thread: ${fromThreadId}`,
      workspace ? `Workspace: ${workspace}` : null,
      "",
      `Handoff instruction: ${instruction}`,
      conversation ? `\nRecent conversation:\n${conversation}` : "",
      git ? `\nGit snapshot:\n${JSON.stringify(git, null, 2)}` : "",
      "",
      "If context is missing, use the hub read_thread or inspect_home tools before proceeding.",
    ].filter((line) => line !== null).join("\n");
    return this.followupTask({
      fromInstance,
      fromThreadId,
      toInstance,
      toThreadId,
      body,
      reason: "cross-instance task handoff",
      priority: "urgent",
      cwd: workspace,
    });
  }

  inspectHome(instance, relativePath = "sessions", maxBytes = 64_000) {
    assertInstance(instance);
    const root = path.resolve(accountHome(instance));
    const target = path.resolve(root, relativePath || "sessions");
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Path escapes the selected CODEX_HOME");
    if (SENSITIVE_PATH.test(target)) throw new Error("Credential and authentication files are excluded from hub inspection");
    if (!fs.existsSync(target)) throw new Error(`Path does not exist: ${relativePath}`);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      return fs.readdirSync(target, { withFileTypes: true })
        .filter((entry) => !SENSITIVE_PATH.test(entry.name))
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
        .slice(0, 500);
    }
    const size = Math.min(stat.size, Math.max(1, Math.min(maxBytes, 256_000)));
    const descriptor = fs.openSync(target, "r");
    try {
      const buffer = Buffer.alloc(size);
      fs.readSync(descriptor, buffer, 0, size, Math.max(0, stat.size - size));
      return { path: relativePath, size: stat.size, tail: buffer.toString("utf8") };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  async #deliver(message, triggerIdleTurn) {
    const client = await this.#requiredClient(message.toInstance);
    let thread;
    try {
      thread = await this.readThread(message.toInstance, message.toThreadId, true);
    } catch (error) {
      this.store.updateMessage(message.id, "failed", { error: error.message });
      throw error;
    }
    const turn = activeTurn(thread);
    const input = textInput(messageEnvelope(message));
    try {
      if (turn) {
        await client.rpc("turn/steer", {
          threadId: message.toThreadId,
          expectedTurnId: turn.id,
          input,
          responsesapiClientMetadata: { "x-hub-message-id": message.id },
        });
        this.store.updateMessage(message.id, "delivered", { turnId: turn.id });
        return true;
      }
      if (triggerIdleTurn) {
        if (threadStatusType(thread) === "notLoaded") {
          const resumed = await client.rpc("thread/resume", { threadId: message.toThreadId });
          thread = resumed.thread || resumed;
        }
        const requestedModel = message.metadata?.model || null;
        const requestedEffort = message.metadata?.reasoningEffort || null;
        const result = await client.rpc("turn/start", {
          threadId: message.toThreadId,
          input,
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(requestedEffort ? { effort: requestedEffort } : {}),
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
          responsesapiClientMetadata: { "x-hub-message-id": message.id },
        });
        const startedTurn = result.turn || result;
        this.store.updateMessage(message.id, "delivered", { turnId: startedTurn.id });
        // Do not depend solely on notification ordering: turn/started may arrive
        // before this RPC resolves, and some ephemeral follow-ups only emit a
        // status transition. The returned turn ID is authoritative.
        await this.#flushThreadQueue(message.toInstance, message.toThreadId, startedTurn.id);
        return true;
      }
      return false;
    } catch (error) {
      this.store.updateMessage(message.id, "failed", { error: error.message });
      throw error;
    }
  }

  async #flushQueues(instance) {
    for (const thread of this.instances[instance].threads) {
      const queued = this.store.queuedMessages(instance, thread.id);
      if (!queued.length) continue;
      if (["active", "running"].includes(threadStatusType(thread))) {
        for (const message of queued) {
          try { await this.#deliver(message, false); } catch { break; }
        }
        continue;
      }
      const waking = queued.find((message) => message.triggerTurn);
      if (waking) {
        try { await this.#deliver(waking, true); } catch {}
      }
    }
  }

  async #flushThreadQueue(instance, threadId, turnId) {
    const queued = this.store.queuedMessages(instance, threadId);
    if (!queued.length) return;
    const client = await this.#requiredClient(instance);
    for (const message of queued) {
      try {
        await client.rpc("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: textInput(messageEnvelope(message)),
          responsesapiClientMetadata: { "x-hub-message-id": message.id },
        });
        this.store.updateMessage(message.id, "delivered", { turnId });
      } catch (error) {
        // A very short turn may finish before the queued steering arrives. Keep
        // the note queued so a future turn can accept it.
        this.store.addEvent({
          instance,
          type: "hub.message.deliveryDeferred",
          threadId,
          turnId,
          payload: { messageId: message.id, error: error.message },
        });
        break;
      }
    }
  }

  async #ensureIntermediator(instance, { model, reasoningEffort, recreate }) {
    const current = this.store.getIntermediator(instance);
    if (current && !recreate) {
      try {
        const thread = await this.readThread(instance, current.threadId, false);
        let updated = current;
        if ((current.roleVersion || 0) < INTERMEDIATOR_ROLE_VERSION) {
          try {
            await this.followupTask({
              fromInstance: instance,
              toInstance: instance,
              toThreadId: current.threadId,
              body: `[Hub Intermediator role update v${INTERMEDIATOR_ROLE_VERSION}]\n\n${intermediatorInstructions(instance)}\n\nAcknowledge this durable role update concisely.`,
              reason: `migrate persistent intermediator to role v${INTERMEDIATOR_ROLE_VERSION}`,
              priority: "high",
              model: model || current.model,
              reasoningEffort: reasoningEffort || current.reasoningEffort,
              kind: "intermediator role update",
            });
            updated = this.store.setIntermediator({
              instance,
              threadId: current.threadId,
              model: model || current.model,
              reasoningEffort: reasoningEffort || current.reasoningEffort,
              roleVersion: INTERMEDIATOR_ROLE_VERSION,
            });
            this.store.addEvent({
              instance,
              type: "hub.intermediator.roleUpdated",
              threadId: current.threadId,
              payload: { fromVersion: current.roleVersion || 0, toVersion: INTERMEDIATOR_ROLE_VERSION },
            });
          } catch (error) {
            this.store.addEvent({
              instance,
              type: "hub.intermediator.roleUpdateDeferred",
              threadId: current.threadId,
              payload: { fromVersion: current.roleVersion || 0, toVersion: INTERMEDIATOR_ROLE_VERSION, error: error.message },
            });
            return { ...current, available: true, status: threadStatusType(thread), recreated: false, roleUpdateDeferred: true, roleUpdateError: error.message };
          }
        }
        if (model || reasoningEffort) {
          updated = this.store.setIntermediator({
            instance,
            threadId: current.threadId,
            model: model || updated.model,
            reasoningEffort: reasoningEffort || updated.reasoningEffort,
            roleVersion: INTERMEDIATOR_ROLE_VERSION,
          });
        }
        return { ...updated, available: true, status: threadStatusType(thread), recreated: false };
      } catch (error) {
        this.store.addEvent({
          instance,
          type: "hub.intermediator.bindingInvalid",
          threadId: current.threadId,
          payload: { error: error.message },
        });
      }
    }

    const started = await this.startThread(instance, {
      ephemeral: false,
      model,
      reasoningEffort,
      name: `Hub Intermediator — ${operatorName(instance)}`,
      developerInstructions: intermediatorInstructions(instance),
      message: "Initialize this persistent Hub Intermediator role. Reply exactly INTERMEDIATOR_READY.",
    });
    const binding = this.store.setIntermediator({
      instance,
      threadId: started.thread.id,
      model,
      reasoningEffort,
      roleVersion: INTERMEDIATOR_ROLE_VERSION,
    });
    this.store.addEvent({
      instance,
      type: "hub.intermediator.created",
      threadId: started.thread.id,
      payload: { model, reasoningEffort, roleVersion: INTERMEDIATOR_ROLE_VERSION, replacedThreadId: current?.threadId || null },
    });
    return { ...binding, available: true, status: threadStatusType(started.thread), recreated: Boolean(current) };
  }

  async #maybeFailoverQuota(instance, threadId, turnId, error) {
    if (!threadId || !error) return;
    const encoded = JSON.stringify(error);
    if (!/(usageLimitExceeded|sessionBudgetExceeded|usage[ _-]?limit|quota)/i.test(encoded)) return;
    const failureKey = `${instance}:${threadId}:${turnId || "unknown"}`;
    if (this.handledQuotaFailures.has(failureKey)) return;
    this.handledQuotaFailures.add(failureKey);

    const depth = this.failoverDepthByThread.get(`${instance}:${threadId}`) || 0;
    if (depth >= 1) {
      this.store.addEvent({
        instance,
        type: "hub.failover.exhausted",
        threadId,
        turnId,
        payload: { error, reason: "The fallback instance also reached a usage limit" },
      });
      return;
    }

    const targetInstance = instanceNames.find((name) => name !== instance);
    this.store.addEvent({
      instance,
      type: "hub.failover.detected",
      threadId,
      turnId,
      payload: { targetInstance, error },
    });
    try {
      const message = await this.prepareHandoff({
        fromInstance: instance,
        fromThreadId: threadId,
        toInstance: targetInstance,
        instruction: "The source account hit its usage quota. Continue the interrupted task, preserving its workspace and intent. Report that this is an automatic quota failover.",
      });
      this.failoverDepthByThread.set(`${targetInstance}:${message.toThreadId}`, depth + 1);
      this.store.addEvent({
        instance: targetInstance,
        type: "hub.failover.started",
        threadId: message.toThreadId,
        payload: { sourceInstance: instance, sourceThreadId: threadId, messageId: message.id },
      });
    } catch (failoverError) {
      this.store.addEvent({
        instance,
        type: "hub.failover.failed",
        threadId,
        turnId,
        payload: { targetInstance, error: failoverError.message },
      });
    }
  }

  async #ensureClient(instance) {
    assertInstance(instance);
    let state;
    try {
      // Windows PowerShell commonly emits UTF-8 JSON with a BOM.
      const rawState = fs.readFileSync(remoteStatePath(instance), "utf8").replace(/^\uFEFF/, "");
      state = JSON.parse(rawState);
    } catch (error) {
      this.instances[instance].connected = false;
      this.instances[instance].error = `Remote host state unavailable: ${error.message}`;
      return null;
    }
    const url = `ws://127.0.0.1:${state.port}`;
    let client = this.clients.get(instance);
    if (client && client.url !== url) {
      client.close();
      this.clients.delete(instance);
      client = null;
    }
    if (!client) {
      client = new CodexAppServerClient({ instance, url });
      client.on("notification", (method, params) => this.#onNotification(instance, method, params));
      client.on("request", (request) => this.#onRequest(instance, request));
      client.on("disconnected", () => {
        this.instances[instance].connected = false;
        this.instances[instance].error = "App server disconnected";
        this.emit("state");
      });
      client.on("error", (error) => {
        this.instances[instance].error = error.message;
        this.emit("error", error);
      });
      this.clients.set(instance, client);
    }
    this.instances[instance].port = state.port;
    if (!client.connected) {
      try {
        await client.connect();
        this.instances[instance].connected = true;
        this.instances[instance].error = null;
        this.store.addEvent({ instance, type: "hub.instance.connected", payload: { port: state.port } });
      } catch (error) {
        this.instances[instance].connected = false;
        this.instances[instance].error = error.message;
      }
    }
    return client;
  }

  async #requiredClient(instance) {
    const client = await this.#ensureClient(instance);
    if (!client?.connected) throw new Error(`${instance} app server is unavailable: ${this.instances[instance].error}`);
    return client;
  }

  #onNotification(instance, method, params) {
    const threadId = params.threadId || params.thread?.id || params.turn?.threadId || null;
    const turnId = params.turnId || params.turn?.id || null;
    // During a blue/green swap both workers briefly receive the same app-server
    // notifications. Only the accepting worker owns persistence and side effects.
    if (!this.acceptingWork) return;
    try {
      this.store.addEvent({ instance, type: method, threadId, turnId, payload: params });
    } catch (error) {
      this.emit("error", error);
      return;
    }
    if (method === "account/rateLimits/updated" && params.rateLimits) {
      this.instances[instance].rateLimits = mergeSparseRateLimits(this.instances[instance].rateLimits, params.rateLimits);
      this.instances[instance].rateLimitsObservedAt = new Date().toISOString();
      this.instances[instance].rateLimitError = null;
    }
    if (method === "turn/started" && threadId && turnId) {
      this.#flushThreadQueue(instance, threadId, turnId).catch((error) => this.emit("error", error));
    }
    if (method === "turn/completed" && threadId) {
      this.#maybeFailoverQuota(instance, threadId, turnId, params.turn?.error || params.error)
        .catch((error) => this.emit("error", error));
    }
    this.emit("state");
  }

  async #refreshRateLimits(instance, client, force = false) {
    const state = this.instances[instance];
    const now = Date.now();
    if (!force && now - state.lastRateLimitReadAt < this.rateLimitPollIntervalMs) return;
    state.lastRateLimitReadAt = now;
    try {
      const result = await client.rpc("account/rateLimits/read", null, 20_000);
      const snapshot = result.rateLimitsByLimitId?.codex || result.rateLimits;
      if (snapshot) {
        // A read is a complete authoritative snapshot, so null removes a lifted window.
        // Rolling notifications remain sparse and are merged in #onNotification.
        state.rateLimits = snapshot;
        state.rateLimitsObservedAt = new Date().toISOString();
      }
      state.rateLimitError = null;
    } catch (error) {
      state.rateLimitError = error.message;
    }
  }

  #onRequest(instance, request) {
    if (!this.acceptingWork) return;
    try {
      this.store.addEvent({
        instance,
        type: `server-request:${request.method}`,
        threadId: request.params?.threadId || null,
        turnId: request.params?.turnId || null,
        payload: { id: request.id, params: request.params },
      });
    } catch (error) {
      this.emit("error", error);
      return;
    }
    this.emit("state");
  }

  #enrichThread(thread) {
    if (!thread?.path) return thread;
    try {
      const stat = fs.statSync(thread.path);
      const cached = this.runtimeCache.get(thread.path);
      if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) {
        return { ...thread, runtime: cached.runtime };
      }

      const tailBytes = Math.min(stat.size, 1_048_576);
      const handle = fs.openSync(thread.path, "r");
      const buffer = Buffer.alloc(tailBytes);
      fs.readSync(handle, buffer, 0, tailBytes, stat.size - tailBytes);
      fs.closeSync(handle);
      const lines = buffer.toString("utf8").split(/\r?\n/);
      let runtime = cached?.runtime || null;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].includes('"type":"turn_context"')) continue;
        try {
          const record = JSON.parse(lines[index]);
          const payload = record.payload || {};
          runtime = {
            model: payload.model || null,
            effort: payload.effort || payload.collaboration_mode?.settings?.reasoning_effort || null,
            collaborationMode: payload.collaboration_mode?.mode || payload.collaboration_mode_kind || null,
          };
          break;
        } catch {
          // A tail read can begin in the middle of a JSONL record.
        }
      }
      this.runtimeCache.set(thread.path, { mtimeMs: stat.mtimeMs, size: stat.size, runtime });
      return runtime ? { ...thread, runtime } : thread;
    } catch {
      return thread;
    }
  }
}
