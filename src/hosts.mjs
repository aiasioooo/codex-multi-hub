import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  hostModel,
  hostReasoningEffort,
  hostTimeZone,
  hubHome,
  instanceNames,
  projectRoot,
} from "./config.mjs";

const HOST_ROLE_VERSION = 3;
const HOST_PERSONA_VERSION = 5;
const HOST_TARGETS = new Set([
  "camera.scene",
  "service.status",
  "theme.palette",
  "relay.traffic",
  "activity.timeline",
  "operator.zxc.scene",
  "operator.aiasio.scene",
  "operator.zxc.card",
  "operator.aiasio.card",
  "operator.zxc.quota",
  "operator.aiasio.quota",
  "operator.zxc.missions",
  "operator.aiasio.missions",
]);
const HOST_COLORS = new Set(["mint", "violet", "pink", "peach", "lemon", "cyan", "neutral", "danger"]);
const HOST_TONES = new Set(["playful", "smug", "dry", "calm", "warm", "serious", "curious", "research"]);
const HOST_STYLES = new Set(["bubble", "thought", "note", "glow", "pulse", "outline", "spotlight", "sparkle"]);
const ACTIVE_STATUSES = new Set(["active", "running", "inProgress"]);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || minimum));
}

function profile(instance) {
  const shared = fs.readFileSync(path.join(projectRoot, "hosts", "shared.md"), "utf8");
  const personal = fs.readFileSync(path.join(projectRoot, "hosts", `${instance}.md`), "utf8");
  return `${shared.trim()}\n\n${personal.trim()}`;
}

function statusType(thread) {
  return thread?.status?.type || thread?.status || "unknown";
}

function localClock(date = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: hostTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${hostTimeZone}`;
}

function automationState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(hubHome, "host-automation-state.json"), "utf8"));
  } catch {
    return null;
  }
}

export class HostDirector {
  constructor(hub) {
    this.hub = hub;
    this.store = hub.store;
    this.ensurePromises = new Map();
  }

  async start() {
    // Retire any lease left by the previous scheduler. Host activity is now
    // driven by the separate lightweight automation process.
    for (const session of this.store.listHostSessions({ state: "active", limit: 100 })) {
      this.store.finishHostSession(session.id, "complete", "retired with sessionless host automation");
    }
  }

  stop() {}

  snapshot() {
    const actions = this.store.listActiveHostActions();
    const automation = automationState();
    return {
      bindings: this.store.listHosts(),
      activeSession: null,
      sessions: [],
      actions,
      research: this.store.listHostActions(80).filter((action) => action.type === "research").slice(0, 12),
      journal: this.store.listHostJournal({ limit: 30 }),
      viewerLastSeenAt: this.store.getRuntimeState("viewer:last_seen")?.value || null,
      schedule: {
        mode: "persistent-wake",
        timeZone: hostTimeZone,
        nextAmbientAt: automation?.nextAmbientAt || null,
        lastWake: automation?.lastWake || null,
      },
    };
  }

  markViewerPresent() {
    const current = this.store.getRuntimeState("viewer:last_seen")?.value;
    if (!current || Date.now() - new Date(current).valueOf() > 15_000) {
      this.store.setRuntimeState("viewer:last_seen", new Date().toISOString());
    }
    return { ok: true };
  }

  async ensureHost(instance, { model = hostModel, reasoningEffort = hostReasoningEffort, recreate = false } = {}) {
    if (!instanceNames.includes(instance)) throw new Error(`Unknown host instance '${instance}'`);
    if (this.ensurePromises.has(instance)) return this.ensurePromises.get(instance);
    const promise = this.#ensureHost(instance, { model, reasoningEffort, recreate });
    this.ensurePromises.set(instance, promise);
    try {
      return await promise;
    } finally {
      this.ensurePromises.delete(instance);
    }
  }

  async listHosts() {
    const result = {};
    for (const instance of instanceNames) {
      const binding = this.store.getHost(instance);
      if (!binding) {
        result[instance] = { instance, available: false, error: "Not created yet" };
        continue;
      }
      try {
        const thread = await this.hub.readThread(instance, binding.threadId, false);
        result[instance] = { ...binding, available: true, status: statusType(thread), name: thread.name || null };
      } catch (error) {
        result[instance] = { ...binding, available: false, error: error.message };
      }
    }
    return result;
  }

  observe(instance, sourceThreadId = null) {
    this.#assertHostCaller(instance, sourceThreadId);
    const observer = this.hub.snapshot();
    return {
      self: this.store.getHost(instance),
      peer: this.store.getHost(instanceNames.find((name) => name !== instance)),
      clock: localClock(),
      automation: automationState(),
      instances: Object.fromEntries(Object.entries(observer.instances || {}).map(([name, value]) => [name, {
        connected: value.connected,
        activeCount: value.activeCount,
        taskCount: value.taskCount,
        queuedCount: value.queuedCount,
        quotaRemaining: value.rateLimit?.remainingPercent ?? null,
        quotaState: value.rateLimitTelemetry?.state || "unknown",
      }])),
      availableTargets: [...HOST_TARGETS],
      activeActions: this.store.listActiveHostActions(),
      recentJournal: this.store.listHostJournal({ limit: 20 }),
      recentlyPublished: this.store.listHostActions(30)
        .filter((action) => action.text)
        .map((action) => ({ instance: action.instance, type: action.type, text: action.text, at: action.createdAt })),
    };
  }

  say({ instance, sourceThreadId, text, tone = "playful", ttlSeconds = 18 }) {
    this.#assertHostCaller(instance, sourceThreadId);
    const clean = this.#text(text, 280);
    const chosenTone = HOST_TONES.has(tone) ? tone : "playful";
    this.store.expireHostActions({ instance, type: "speech" });
    const action = this.#action({ instance, type: "speech", target: `operator.${instance}.scene`, text: clean, tone: chosenTone, ttlSeconds });
    this.store.addHostJournal({ instance, kind: "dialogue", text: clean, metadata: { tone: chosenTone } });
    return action;
  }

  callout({ instance, sourceThreadId, target, text, color = null, style = "bubble", ttlSeconds = 16 }) {
    this.#assertHostCaller(instance, sourceThreadId);
    this.#target(target);
    const action = this.#action({
      instance,
      type: "callout",
      target,
      text: this.#text(text, 220),
      color: this.#color(color, instance),
      style: HOST_STYLES.has(style) ? style : "bubble",
      ttlSeconds,
    });
    this.store.addHostJournal({ instance, kind: "visual", text: `${target}: ${action.text}`, metadata: { actionId: action.id } });
    return action;
  }

  highlight({ instance, sourceThreadId, target, color = null, style = "glow", ttlSeconds = 14 }) {
    this.#assertHostCaller(instance, sourceThreadId);
    this.#target(target);
    return this.#action({
      instance,
      type: "highlight",
      target,
      color: this.#color(color, instance),
      style: HOST_STYLES.has(style) ? style : "glow",
      ttlSeconds,
    });
  }

  camera({ instance, sourceThreadId, target = "hub", ttlSeconds = 10 }) {
    this.#assertHostCaller(instance, sourceThreadId);
    if (!["zxc", "aiasio", "hub"].includes(target)) throw new Error("Camera target must be zxc, aiasio, or hub");
    this.store.expireHostActions({ type: "camera" });
    return this.#action({ instance, type: "camera", target, ttlSeconds });
  }

  async contact({ instance, sourceThreadId, message }) {
    this.#assertHostCaller(instance, sourceThreadId);
    const targetInstance = instanceNames.find((name) => name !== instance);
    const target = await this.ensureHost(targetInstance);
    const thread = await this.hub.readThread(targetInstance, target.threadId, false);
    const clean = this.#text(message, 1_200);
    const body = `[Host contact ${instance} → ${targetInstance}]\n${clean}`;
    const active = ACTIVE_STATUSES.has(statusType(thread));
    const delivered = active
      ? await this.hub.sendMessage({
          fromInstance: instance,
          fromThreadId: sourceThreadId,
          toInstance: targetInstance,
          toThreadId: target.threadId,
          body,
          reason: "persistent host contact",
          priority: "normal",
          kind: "host contact",
        })
      : await this.hub.followupTask({
          fromInstance: instance,
          fromThreadId: sourceThreadId,
          toInstance: targetInstance,
          toThreadId: target.threadId,
          body,
          reason: "persistent host contact",
          priority: "normal",
          model: target.model,
          reasoningEffort: target.reasoningEffort,
          kind: "host contact",
        });
    this.store.addHostJournal({ instance, kind: "contact", text: clean, metadata: { to: targetInstance, messageId: delivered.id } });
    return { peer: target, active, message: delivered };
  }

  remember({ instance, sourceThreadId, text, kind = "memory" }) {
    this.#assertHostCaller(instance, sourceThreadId);
    const clean = this.#text(text, 600);
    const id = this.store.addHostJournal({ instance, kind, text: clean });
    return { id, instance, kind, text: clean };
  }

  research({ instance, sourceThreadId, title, summary, sources }) {
    this.#assertHostCaller(instance, sourceThreadId);
    const links = (Array.isArray(sources) ? sources : []).slice(0, 6).map((source) => {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Research sources must use HTTP or HTTPS");
      return { title: this.#text(source.title || url.hostname, 120), url: url.href };
    });
    if (!links.length) throw new Error("At least one source is required");
    const action = this.#action({
      instance,
      type: "research",
      target: "activity.timeline",
      text: this.#text(summary, 600),
      tone: "research",
      color: this.#color(null, instance),
      ttlSeconds: 7 * 24 * 60 * 60,
      payload: { title: this.#text(title, 160), sources: links },
    });
    this.store.addHostJournal({ instance, kind: "research", text: `${action.payload.title}: ${action.text}`, metadata: { sources: links } });
    return action;
  }

  async #ensureHost(instance, { model, reasoningEffort, recreate }) {
    const current = this.store.getHost(instance);
    if (current && !recreate) {
      try {
        const thread = await this.hub.readThread(instance, current.threadId, false);
        const stale = (current.roleVersion || 0) < HOST_ROLE_VERSION || (current.personaVersion || 0) < HOST_PERSONA_VERSION;
        if (!stale) {
          const updated = this.store.setHost({
            instance,
            threadId: current.threadId,
            model: model || current.model,
            reasoningEffort: reasoningEffort || current.reasoningEffort,
            roleVersion: HOST_ROLE_VERSION,
            personaVersion: HOST_PERSONA_VERSION,
          });
          return { ...updated, available: true, status: statusType(thread), recreated: false };
        }
      } catch (error) {
        this.store.addEvent({ instance, type: "hub.host.bindingInvalid", threadId: current.threadId, payload: { error: error.message } });
      }
    }

    const started = await this.hub.startThread(instance, {
      ephemeral: false,
      model,
      reasoningEffort,
      name: `Nacchan Host — ${instance}`,
      developerInstructions: profile(instance),
    });
    const binding = this.store.setHost({
      instance,
      threadId: started.thread.id,
      model,
      reasoningEffort,
      roleVersion: HOST_ROLE_VERSION,
      personaVersion: HOST_PERSONA_VERSION,
    });
    await this.hub.followupTask({
      fromInstance: instance,
      toInstance: instance,
      toThreadId: started.thread.id,
      body: "Begin your persistent Nacchan Host task. Familiarize yourself with the installed hub-navigation and observer-stage skills. Do not publish anything merely to acknowledge initialization; reply briefly when ready.",
      reason: "initialize persistent operator host",
      priority: "high",
      model,
      reasoningEffort,
      kind: "host initialization",
    });

    if (current?.threadId && current.threadId !== started.thread.id) {
      try {
        const replaced = await this.hub.readThread(instance, current.threadId, false);
        if (!ACTIVE_STATUSES.has(statusType(replaced))) await this.hub.archiveThread(instance, current.threadId);
      } catch (error) {
        this.store.addEvent({ instance, type: "hub.host.retireFailed", threadId: current.threadId, payload: { error: error.message } });
      }
    }
    this.store.addEvent({
      instance,
      type: "hub.host.created",
      threadId: started.thread.id,
      payload: { model, reasoningEffort, roleVersion: HOST_ROLE_VERSION, personaVersion: HOST_PERSONA_VERSION, replacedThreadId: current?.threadId || null },
    });
    return { ...binding, available: true, status: statusType(started.thread), recreated: Boolean(current) };
  }

  #assertHostCaller(instance, sourceThreadId) {
    const binding = this.store.getHost(instance);
    if (!binding) throw new Error(`${instance} host has not been created`);
    if (!sourceThreadId || binding.threadId !== sourceThreadId) throw new Error(`Host UI tools are bound to ${instance}/${binding.threadId}`);
    return binding;
  }

  #action({ instance, type, target = null, text = null, tone = null, color = null, style = null, ttlSeconds = 15, payload = {} }) {
    const expiresAt = new Date(Date.now() + clamp(ttlSeconds, 3, type === "research" ? 7 * 24 * 60 * 60 : 180) * 1000).toISOString();
    const action = this.store.createHostAction({
      id: `action_${crypto.randomUUID()}`,
      sessionId: null,
      instance,
      type,
      target,
      text,
      tone,
      color,
      style,
      expiresAt,
      payload,
    });
    this.store.addEvent({ instance, type: `hub.host.${type}`, threadId: this.store.getHost(instance)?.threadId || null, payload: { actionId: action.id, target, tone, color, style } });
    return action;
  }

  #target(target) {
    if (!HOST_TARGETS.has(target)) throw new Error(`Unknown host UI target '${target}'`);
  }

  #color(color, instance) {
    if (!color) return instance === "zxc" ? "mint" : "violet";
    if (!HOST_COLORS.has(color)) throw new Error(`Unknown host color '${color}'`);
    return color;
  }

  #text(value, maximum) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("Host text cannot be empty");
    return clean.slice(0, maximum);
  }
}

export const hostUiTargets = [...HOST_TARGETS];
