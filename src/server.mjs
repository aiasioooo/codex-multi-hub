import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { assertHubSource, hubHost, hubPort, projectRoot } from "./config.mjs";
import { CodexHub } from "./hub.mjs";

const publicRoot = path.join(projectRoot, "public");
const workerPort = Number.parseInt(process.env.CODEX_HUB_PORT || String(hubPort), 10);
const controlToken = process.env.CODEX_HUB_CONTROL_TOKEN || null;
const autostart = process.env.CODEX_HUB_AUTOSTART !== "0";
const parentPid = Number.parseInt(process.env.CODEX_HUB_PARENT_PID || "0", 10);
const slot = process.env.CODEX_HUB_SLOT || "direct";
let hub = null;
let phase = "standby";
let acceptingWork = false;
let lastSnapshot = null;

function sendJson(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function snapshot() {
  if (hub) {
    lastSnapshot = hub.snapshot();
    return lastSnapshot;
  }
  return lastSnapshot || { now: new Date().toISOString(), instances: {}, activity: [], messages: [], events: [] };
}

async function activate() {
  if (phase === "active") return;
  if (phase === "starting") throw new Error("Worker activation is already in progress");
  phase = "starting";
  const nextHub = new CodexHub();
  nextHub.on("error", (error) => console.error(`[hub:${slot}] ${error.stack || error.message}`));
  try {
    await nextHub.start();
    hub = nextHub;
    acceptingWork = true;
    phase = "active";
    lastSnapshot = hub.snapshot();
  } catch (error) {
    await nextHub.stop().catch(() => {});
    phase = "standby";
    throw error;
  }
}

function setDraining(value) {
  if (!hub) return;
  acceptingWork = !value;
  hub.setAcceptingWork(acceptingWork);
  phase = value ? "draining" : "active";
}

async function deactivate() {
  if (!hub) {
    phase = "standby";
    return;
  }
  phase = "stopping";
  acceptingWork = false;
  hub.setAcceptingWork(false);
  lastSnapshot = hub.snapshot();
  const previous = hub;
  hub = null;
  await previous.stop();
  phase = "standby";
}

async function callTool(name, sourceInstance, args) {
  if (sourceInstance === "gui" && [
    "host_observe",
    "host_say",
    "host_callout",
    "host_highlight",
    "host_camera",
    "host_contact",
    "host_remember",
    "host_research",
  ].includes(name)) {
    throw new Error(`Hub tool '${name}' may only be called by a bound zxc or aiasio Operator Host task`);
  }
  if (sourceInstance === "gui" && name === "prepare_handoff") {
    throw new Error("A GUI task cannot be read as an operator source by prepare_handoff; send a concise followup_task summary or ask the owning operator to prepare the handoff");
  }
  if (!hub) throw new Error("Hub worker is in standby");
  switch (name) {
    case "status": return snapshot();
    case "list_threads": return hub.listThreads(args.instance || null, args.limit || 30);
    case "list_models": return hub.listModels(args.instance, Boolean(args.include_hidden), args.limit || 100);
    case "read_thread": return hub.readThread(args.instance, args.thread_id, args.include_turns ?? true);
    case "start_thread": return hub.startThread(args.instance, { message: args.message || null, cwd: args.cwd || null, ephemeral: Boolean(args.ephemeral), model: args.model || null, reasoningEffort: args.reasoning_effort || null });
    case "fork_thread": return hub.forkThread(args.instance, args.thread_id, { message: args.message || null, cwd: args.cwd || null, ephemeral: Boolean(args.ephemeral), model: args.model || null, reasoningEffort: args.reasoning_effort || null });
    case "reload_mcp": return hub.reloadMcp(args.instance);
    case "ensure_intermediator": return hub.ensureIntermediator(args.instance, { model: args.model || null, reasoningEffort: args.reasoning_effort || null, recreate: Boolean(args.recreate) });
    case "list_intermediators": return hub.listIntermediators();
    case "ask_intermediator": return hub.askIntermediator({ fromInstance: sourceInstance, fromThreadId: args.source_thread_id || null, toInstance: args.target_instance, body: args.message, reason: args.reason || null, priority: args.priority || "normal", model: args.model || null, reasoningEffort: args.reasoning_effort || null });
    case "ensure_host": return hub.ensureHost(args.instance, { model: args.model || undefined, reasoningEffort: args.reasoning_effort || undefined, recreate: Boolean(args.recreate) });
    case "list_hosts": return hub.listHosts();
    case "host_observe": return hub.hostObserve(sourceInstance, args.source_thread_id);
    case "host_say": return hub.hostSay({ instance: sourceInstance, sourceThreadId: args.source_thread_id, text: args.text, tone: args.tone || "playful", ttlSeconds: args.ttl_seconds || 18 });
    case "host_callout": return hub.hostCallout({ instance: sourceInstance, sourceThreadId: args.source_thread_id, target: args.target, text: args.text, color: args.color || null, style: args.style || "bubble", ttlSeconds: args.ttl_seconds || 16 });
    case "host_highlight": return hub.hostHighlight({ instance: sourceInstance, sourceThreadId: args.source_thread_id, target: args.target, color: args.color || null, style: args.style || "glow", ttlSeconds: args.ttl_seconds || 14 });
    case "host_camera": return hub.hostCamera({ instance: sourceInstance, sourceThreadId: args.source_thread_id, target: args.target || "hub", ttlSeconds: args.ttl_seconds || 10 });
    case "host_contact": return hub.hostContact({ instance: sourceInstance, sourceThreadId: args.source_thread_id, message: args.message });
    case "host_remember": return hub.hostRemember({ instance: sourceInstance, sourceThreadId: args.source_thread_id, text: args.text, kind: args.kind || "memory" });
    case "host_research": return hub.hostResearch({ instance: sourceInstance, sourceThreadId: args.source_thread_id, title: args.title, summary: args.summary, sources: args.sources });
    case "list_host_actions": return hub.store.listHostActions(args.limit || 100);
    case "send_message": return hub.sendMessage({ fromInstance: sourceInstance, fromThreadId: args.source_thread_id || null, toInstance: args.target_instance, toThreadId: args.target_thread_id, body: args.message, reason: args.reason || null, priority: args.priority || "normal" });
    case "leave_note": return hub.leaveNote({ fromInstance: sourceInstance, fromThreadId: args.source_thread_id || null, toInstance: args.target_instance, toThreadId: args.target_thread_id, body: args.message, reason: args.reason || null, priority: args.priority || "normal" });
    case "cancel_message": return hub.cancelMessage(sourceInstance, args.message_id, args.reason || null);
    case "followup_task": return hub.followupTask({ fromInstance: sourceInstance, fromThreadId: args.source_thread_id || null, toInstance: args.target_instance, toThreadId: args.target_thread_id || null, body: args.message, reason: args.reason || null, priority: args.priority || "normal", cwd: args.cwd || null, model: args.model || null, reasoningEffort: args.reasoning_effort || null });
    case "steer_thread": return hub.steerThread({ fromInstance: sourceInstance, toInstance: args.target_instance, threadId: args.target_thread_id, body: args.message, reason: args.reason || null, queueIfIdle: args.queue_if_idle ?? true });
    case "interrupt_thread": return hub.interruptThread({ fromInstance: sourceInstance, toInstance: args.target_instance, threadId: args.target_thread_id, reason: args.reason || null });
    case "prepare_handoff": return hub.prepareHandoff({ fromInstance: sourceInstance, fromThreadId: args.source_thread_id, toInstance: args.target_instance, toThreadId: args.target_thread_id || null, instruction: args.instruction, cwd: args.cwd || null });
    case "inspect_home": return hub.inspectHome(args.instance, args.relative_path || "sessions", args.max_bytes || 64_000);
    case "list_messages": return hub.store.listMessages({ limit: args.limit || 100, state: args.state || null, instance: args.instance || null, threadId: args.thread_id || null });
    case "list_events": return hub.store.listEvents(args.limit || 100);
    default: throw new Error(`Unknown hub tool '${name}'`);
  }
}

function authorizedControl(request) {
  return controlToken && request.headers["x-hub-control-token"] === controlToken;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${hubHost}:${workerPort}`}`);
    if (url.pathname.startsWith("/_worker/")) {
      if (url.pathname === "/_worker/health") {
        return sendJson(response, 200, { ok: true, slot, phase, active: phase === "active", acceptingWork, pid: process.pid });
      }
      if (!authorizedControl(request)) return sendJson(response, 404, { error: "Not found" });
      if (request.method === "POST" && url.pathname === "/_worker/activate") await activate();
      else if (request.method === "POST" && url.pathname === "/_worker/drain") setDraining(true);
      else if (request.method === "POST" && url.pathname === "/_worker/resume") setDraining(false);
      else if (request.method === "POST" && url.pathname === "/_worker/deactivate") await deactivate();
      else return sendJson(response, 404, { error: "Not found" });
      return sendJson(response, 200, { ok: true, slot, phase, acceptingWork });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, phase === "active" ? 200 : 503, { ok: phase === "active", slot, phase, instances: snapshot().instances });
    }
    if (request.method === "GET" && url.pathname === "/api/state") return sendJson(response, 200, snapshot());
    if (request.method === "POST" && url.pathname === "/api/presence") {
      if (!hub) return sendJson(response, 503, { error: "Hub worker is in standby" });
      return sendJson(response, 200, hub.markViewerPresent());
    }
    const threadMatch = url.pathname.match(/^\/api\/threads\/(zxc|aiasio)\/([^/]+)$/);
    if (request.method === "GET" && threadMatch) {
      if (!hub) return sendJson(response, 503, { error: "Hub worker is in standby" });
      return sendJson(response, 200, await hub.inspectThread(threadMatch[1], decodeURIComponent(threadMatch[2])));
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/tools/")) {
      if (!acceptingWork) return sendJson(response, 503, { error: "Hub is switching workers; retry shortly" });
      const sourceInstance = request.headers["x-hub-instance"];
      try {
        assertHubSource(sourceInstance);
      } catch {
        return sendJson(response, 400, { error: "Missing or invalid X-Hub-Instance header" });
      }
      const args = await readJson(request);
      const result = await callTool(decodeURIComponent(url.pathname.slice("/api/tools/".length)), sourceInstance, args);
      return sendJson(response, 200, { result });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(publicRoot, requested);
    if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) return sendJson(response, 403, { error: "Forbidden" });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(response, 404, { error: "Not found" });
    const data = fs.readFileSync(file);
    response.writeHead(200, {
      "content-type": contentType(file),
      "content-length": data.length,
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      pragma: "no-cache",
      expires: "0",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(workerPort, hubHost, async () => {
  console.log(`Codex Multi worker ${slot} listening on http://${hubHost}:${workerPort}`);
  if (autostart) {
    try { await activate(); } catch (error) { console.error(error.stack || error.message); }
  }
});

async function shutdown(signal) {
  console.log(`Stopping worker ${slot} (${signal})`);
  server.close();
  await deactivate().catch(() => {});
  process.exit(0);
}

if (parentPid) {
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch { shutdown("parent-exited"); }
  }, 2_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
