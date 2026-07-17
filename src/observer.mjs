const IMPORTANT_EVENTS = new Map([
  ["hub.failover.detected", ["failover", "Quota fallback detected"]],
  ["hub.failover.started", ["failover", "Fallback task started"]],
  ["hub.failover.failed", ["error", "Fallback failed"]],
  ["hub.failover.exhausted", ["error", "Both quotas exhausted"]],
  ["hub.thread.started", ["task", "Task created"]],
  ["hub.intermediator.created", ["intermediator", "Intermediator ready"]],
  ["hub.host.created", ["host", "Operator host ready"]],
  ["hub.host.session.started", ["host", "Host session started"]],
  ["hub.host.session.completed", ["host", "Host session completed"]],
  ["hub.message.canceled", ["message", "Queued message canceled"]],
]);

function epochIso(value) {
  if (!value) return null;
  const milliseconds = Number(value) < 10_000_000_000 ? Number(value) * 1000 : Number(value);
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function statusType(value) {
  return value?.type || value || "unknown";
}

function rateLimitTelemetryState(error, observedAt) {
  if (error) {
    return /401|unauthori[sz]ed|token|sign[ -]?in|log[ -]?in/i.test(String(error))
      ? "auth-required"
      : "unavailable";
  }
  const observedMs = observedAt ? new Date(observedAt).valueOf() : Number.NaN;
  if (!Number.isFinite(observedMs) || Date.now() - observedMs > 120_000) return "stale";
  return "live";
}

function cleanPreview(value = "") {
  return String(value)
    .replace(/^\[Hub[^\]]*\]\s*/i, "")
    .replace(/^Message ID:.*$/gim, "")
    .replace(/^Reason:\s*/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function taskTitle(thread) {
  if (thread.name) return thread.name;
  const preview = cleanPreview(thread.preview);
  if (!preview) return "Untitled task";
  return preview.length > 72 ? `${preview.slice(0, 69)}…` : preview;
}

function summarizePayload(payload) {
  if (!payload) return "";
  if (payload.reason) return String(payload.reason);
  if (payload.error) return typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error);
  if (payload.targetInstance) return `Routing work to ${payload.targetInstance}`;
  if (payload.sourceInstance) return `Continuing work from ${payload.sourceInstance}`;
  return "";
}

export function buildObserverState({
  instances,
  intermediators,
  messages,
  events,
  hosts = [],
  hostSessions = [],
  hostActions = [],
  hostResearch = [],
  hostJournal = [],
  hostSchedule = null,
  viewerLastSeenAt = null,
}) {
  const intermediaryByInstance = new Map(intermediators.map((entry) => [entry.instance, entry]));
  const hostByInstance = new Map(hosts.map((entry) => [entry.instance, entry]));
  const rateByInstance = new Map();
  for (const event of events) {
    if (event.type === "account/rateLimits/updated" && !rateByInstance.has(event.instance)) {
      rateByInstance.set(event.instance, { ...event.payload?.rateLimits, observedAt: event.createdAt });
    }
  }

  const observerInstances = {};
  for (const [name, instance] of Object.entries(instances)) {
    const intermediary = intermediaryByInstance.get(name);
    const host = hostByInstance.get(name);
    const eventRate = rateByInstance.get(name) || null;
    const rate = instance.rateLimits
      ? { ...instance.rateLimits, observedAt: instance.rateLimitsObservedAt }
      : eventRate;
    const primary = rate?.primary || null;
    const secondary = rate?.secondary || null;
    const telemetryState = rateLimitTelemetryState(instance.rateLimitError, rate?.observedAt);
    const queued = messages.filter((message) => message.toInstance === name && message.state === "queued").length;
    const tasks = instance.threads.map((thread) => {
      const status = statusType(thread.status);
      return {
        id: thread.id,
        title: taskTitle(thread),
        preview: cleanPreview(thread.preview),
        status,
        active: ["active", "running", "inProgress"].includes(status),
        cwd: thread.cwd || null,
        workspace: thread.cwd ? thread.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : null,
        createdAt: epochIso(thread.createdAt),
        updatedAt: epochIso(thread.recencyAt || thread.updatedAt),
        model: thread.runtime?.model || null,
        effort: thread.runtime?.effort || null,
        collaborationMode: thread.runtime?.collaborationMode || null,
        modelProvider: thread.modelProvider || null,
        cliVersion: thread.cliVersion || null,
        ephemeral: Boolean(thread.ephemeral),
        intermediary: intermediary?.threadId === thread.id,
        host: host?.threadId === thread.id,
      };
    }).sort((a, b) => Number(b.host) - Number(a.host)
      || Number(b.intermediary) - Number(a.intermediary)
      || Number(b.active) - Number(a.active)
      || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const active = tasks.filter((task) => task.active).length;
    observerInstances[name] = {
      name,
      connected: instance.connected,
      error: instance.error,
      port: instance.port,
      updatedAt: instance.updatedAt,
      taskCount: tasks.length,
      activeCount: active,
      queuedCount: queued,
      rateLimitTelemetry: {
        state: telemetryState,
        observedAt: rate?.observedAt || null,
      },
      rateLimit: primary ? {
        usedPercent: primary.usedPercent,
        remainingPercent: Math.max(0, 100 - Number(primary.usedPercent || 0)),
        resetsAt: epochIso(primary.resetsAt),
        windowMinutes: primary.windowDurationMins,
        reached: Boolean(rate.rateLimitReachedType),
        plan: rate.planType || null,
        observedAt: rate.observedAt,
        secondary: secondary ? {
          usedPercent: secondary.usedPercent,
          remainingPercent: Math.max(0, 100 - Number(secondary.usedPercent || 0)),
          resetsAt: epochIso(secondary.resetsAt),
          windowMinutes: secondary.windowDurationMins,
          observedAt: rate.observedAt,
        } : null,
      } : null,
      intermediator: intermediary ? {
        ...intermediary,
        available: instance.connected && tasks.some((task) => task.id === intermediary.threadId),
        status: tasks.find((task) => task.id === intermediary.threadId)?.status || "unknown",
      } : null,
      host: host ? {
        ...host,
        available: instance.connected && tasks.some((task) => task.id === host.threadId),
        status: tasks.find((task) => task.id === host.threadId)?.status || "unknown",
      } : null,
      tasks,
    };
  }

  const hiddenHostInfrastructure = (message) => {
    const kind = String(message.kind || "");
    const reason = String(message.reason || "");
    const body = String(message.body || "");
    return /^host (?:initialization|(?:ambient|daily|weekly|manual) activation)$/.test(kind)
      || /(?:initialize|install) persistent (?:operator )?host|persistent host wake/i.test(reason)
      || /^\[Host wake [^\]]+\]/.test(body)
      || /^\[(?:Live host session|Host session|Host ambient)\b/.test(body)
      || /^\[Operator Host session activation\]/.test(body)
      || /^Your host automation is now installed\./.test(body);
  };
  const activity = [
    ...messages.filter((message) => message.state !== "canceled" && !hiddenHostInfrastructure(message)).map((message) => {
      const hostChat = ["host conversation", "host contact"].includes(message.kind);
      return {
        id: `message:${message.id}`,
        at: message.updatedAt || message.createdAt,
        kind: hostChat ? "host-chat" : "communication",
        title: hostChat ? message.fromInstance : `${message.fromInstance} → ${message.toInstance}`,
        summary: message.reason && !hostChat ? message.reason : cleanPreview(message.body),
        state: message.state,
        fromInstance: message.fromInstance,
        toInstance: message.toInstance,
        threadId: message.toThreadId,
        messageId: message.id,
        hostMode: hostChat ? "exchange" : null,
      };
    }),
    ...events.filter((event) => IMPORTANT_EVENTS.has(event.type)).map((event) => {
      const [kind, title] = IMPORTANT_EVENTS.get(event.type);
      return {
        id: `event:${event.id}`,
        at: event.createdAt,
        kind,
        title,
        summary: summarizePayload(event.payload),
        state: kind === "error" ? "failed" : "complete",
        instance: event.instance,
        threadId: event.threadId,
      };
    }),
    ...hostResearch.map((action) => ({
      id: `host-research:${action.id}`,
      at: action.createdAt,
      kind: "host-research",
      title: action.payload?.title || `${action.instance} found something`,
      summary: action.text,
      state: "complete",
      instance: action.instance,
      sessionId: action.sessionId,
      sources: action.payload?.sources || [],
    })),
    // Component notes are transient stage direction, not a second line of
    // dialogue. Keep them out of Club Chat while retaining them in the host
    // journal for continuity and diagnostics.
    ...hostJournal.filter((entry) => entry.kind === "dialogue").map((entry) => ({
      id: `host-journal:${entry.id}`,
      at: entry.createdAt,
      kind: "host-chat",
      title: entry.instance,
      summary: entry.text,
      state: "said",
      instance: entry.instance,
      fromInstance: entry.instance,
      sessionId: entry.sessionId,
      hostMode: "dialogue",
      tone: entry.metadata?.tone || null,
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);

  const observerHosts = Object.fromEntries(Object.entries(observerInstances).map(([name, instance]) => [name, instance.host || {
    instance: name,
    available: false,
    status: "missing",
  }]));

  return {
    now: new Date().toISOString(),
    instances: observerInstances,
    intermediators,
    messages,
    activity,
    events,
    hosts: observerHosts,
    hostSessions,
    activeHostSession: hostSessions.find((session) => session.state === "active") || null,
    hostActions,
    hostJournal,
    hostSchedule,
    viewerLastSeenAt,
  };
}
