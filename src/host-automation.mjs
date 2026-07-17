import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { hubBaseUrl, hubHome, hostTimeZone } from "./config.mjs";

const MODEL = "gpt-5.6-sol";
const REASONING_EFFORT = "low";
const TICK_MS = 30_000;
const AMBIENT_MINUTES = [180, 300];
const AMBIENT_REPEAT_CHANCE = 0.05;
const DAILY = { hour: 20, minute: 30, windowMinutes: 180 };
const WEEKLY = { weekday: 0, hour: 20, minute: 0, windowMinutes: 240 };
const statePath = path.join(hubHome, "host-automation-state.json");
const servicePath = path.join(hubHome, "host-automation-service.json");
const bindingsPath = path.join(hubHome, "host-bindings.json");
const ACTIVE_STATUSES = new Set(["active", "running", "inProgress"]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const localBindings = readJson(bindingsPath, {});
const HOSTS = {
  zxc: process.env.CODEX_HOST_ZXC_THREAD_ID || localBindings.zxc || null,
  aiasio: process.env.CODEX_HOST_AIASIO_THREAD_ID || localBindings.aiasio || null,
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function log(message, detail = null) {
  const suffix = detail == null ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  process.stdout.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
}

function localParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: hostTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdays.indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    label: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${hostTimeZone}`,
  };
}

function inWindow(clock, schedule) {
  const start = schedule.hour * 60 + schedule.minute;
  return clock.minutes >= start && clock.minutes < start + schedule.windowMinutes;
}

function ambientDelay() {
  const [minimum, maximum] = AMBIENT_MINUTES;
  return (minimum + Math.floor(Math.random() * (maximum - minimum + 1))) * 60_000;
}

function initialState() {
  return {
    version: 1,
    nextAmbientAt: new Date(Date.now() + ambientDelay()).toISOString(),
    lastWake: null,
    lastHostByKind: {},
    claims: {},
  };
}

function loadState() {
  const state = readJson(statePath, initialState());
  state.lastHostByKind ||= {};
  state.claims ||= {};
  if (!state.nextAmbientAt) state.nextAmbientAt = new Date(Date.now() + ambientDelay()).toISOString();
  return state;
}

function chooseHost(state, kind) {
  const previous = state.lastHostByKind[kind] || null;
  if (!previous) return Math.random() < 0.5 ? "zxc" : "aiasio";
  if (kind === "ambient" && Math.random() < AMBIENT_REPEAT_CHANCE) return previous;
  return previous === "zxc" ? "aiasio" : "zxc";
}

function statusType(thread) {
  return thread?.status?.type || thread?.status || "unknown";
}

async function callHub(name, args) {
  const response = await fetch(`${hubBaseUrl}/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-instance": "gui" },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(90_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Hub returned HTTP ${response.status}`);
  return value.result;
}

export function buildHostWake(kind, instance, date = new Date()) {
  return `[Host wake ${kind}_${instance}]\n${kind} · ${localParts(date).label}`;
}

async function wake(instance, kind, state) {
  const threadId = HOSTS[instance];
  if (!threadId || threadId.startsWith("__")) throw new Error(`Host automation binding for ${instance} is not installed`);
  const thread = await callHub("read_thread", { instance, thread_id: threadId, include_turns: false });
  const status = statusType(thread);
  if (ACTIVE_STATUSES.has(status)) return { ok: false, skipped: "busy", status };

  const at = new Date();
  const message = buildHostWake(kind, instance, at);
  const result = await callHub("followup_task", {
    target_instance: instance,
    target_thread_id: threadId,
    message,
    reason: `${kind} persistent host wake`,
    priority: kind === "ambient" ? "normal" : "high",
    model: MODEL,
    reasoning_effort: REASONING_EFFORT,
  });
  state.lastHostByKind[kind] = instance;
  state.lastWake = { instance, kind, at: at.toISOString(), threadId };
  writeJson(statePath, state);
  log(`woke ${instance}`, { kind, threadId });
  return { ok: true, result };
}

async function runFixedWake(state, kind, key) {
  if (state.claims[key]) return false;
  const instance = chooseHost(state, kind);
  const result = await wake(instance, kind, state);
  if (!result.ok) {
    log(`deferred ${kind} wake`, result);
    return false;
  }
  state.claims[key] = { instance, at: new Date().toISOString() };
  writeJson(statePath, state);
  return true;
}

async function tick(state) {
  const clock = localParts();
  const weeklyKey = `weekly:${clock.date}`;
  const dailyKey = `daily:${clock.date}`;

  if (clock.weekday === WEEKLY.weekday && inWindow(clock, WEEKLY)) {
    const woke = await runFixedWake(state, "weekly", weeklyKey);
    if (woke) {
      state.claims[dailyKey] = { coveredBy: weeklyKey, at: new Date().toISOString() };
      writeJson(statePath, state);
      return;
    }
  }

  if (inWindow(clock, DAILY) && !state.claims[weeklyKey]) {
    if (await runFixedWake(state, "daily", dailyKey)) return;
  }

  if (new Date(state.nextAmbientAt).valueOf() <= Date.now()) {
    const instance = chooseHost(state, "ambient");
    try {
      const result = await wake(instance, "ambient", state);
      state.nextAmbientAt = new Date(Date.now() + (result.ok ? ambientDelay() : 15 * 60_000)).toISOString();
    } catch (error) {
      state.nextAmbientAt = new Date(Date.now() + 15 * 60_000).toISOString();
      log("ambient wake failed", error.message);
    }
    writeJson(statePath, state);
  }
}

async function runService() {
  const state = loadState();
  writeJson(statePath, state);
  writeJson(servicePath, { processId: process.pid, startedAt: new Date().toISOString(), statePath, status: "running" });
  log("host automation started", { nextAmbientAt: state.nextAmbientAt });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      await tick(state);
    } catch (error) {
      log("automation tick failed", error.stack || error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  writeJson(servicePath, { processId: process.pid, startedAt: readJson(servicePath, {}).startedAt || null, stoppedAt: new Date().toISOString(), statePath, status: "stopped" });
  log("host automation stopped");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wakeIndex = process.argv.indexOf("--wake");
  if (wakeIndex !== -1) {
    const instance = process.argv[wakeIndex + 1];
    const kind = process.argv[wakeIndex + 2] || "manual";
    if (!Object.hasOwn(HOSTS, instance)) throw new Error("Manual wake instance must use internal key zxc or aiasio");
    if (!["ambient", "daily", "weekly", "manual"].includes(kind)) throw new Error("Manual wake kind must be ambient, daily, weekly, or manual");
    const state = loadState();
    const result = await wake(instance, kind, state);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    await runService();
  }
}
