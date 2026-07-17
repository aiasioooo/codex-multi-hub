import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { hubHost, hubPort, hubHome, projectRoot } from "./config.mjs";

const workerScript = path.join(projectRoot, "src", "server.mjs");
const controlToken = process.env.CODEX_HUB_CONTROL_TOKEN || crypto.randomBytes(32).toString("hex");
const publicPassword = process.env.CODEX_HUB_PASSWORD || crypto.randomBytes(24).toString("base64url");
const slots = {
  blue: { name: "blue", port: hubPort + 10, child: null, phase: "offline", generation: 0, intentional: false },
  green: { name: "green", port: hubPort + 11, child: null, phase: "offline", generation: 0, intentional: false },
};
const sessions = new Map();
const startedAt = new Date().toISOString();
let activeSlot = null;
let generation = 0;
let reloading = false;
let shuttingDown = false;

fs.mkdirSync(hubHome, { recursive: true });

function json(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

function isLocalRequest(request) {
  const host = String(request.headers.host || "").split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function isAuthenticated(request) {
  if (isLocalRequest(request)) return true;
  const token = parseCookies(request).hub_session;
  const expiresAt = token && sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

async function readBody(request, limit = 16_384) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function passwordsMatch(candidate) {
  const actual = Buffer.from(publicPassword);
  const supplied = Buffer.from(String(candidate || ""));
  return actual.length === supplied.length && crypto.timingSafeEqual(actual, supplied);
}

function serviceState() {
  return {
    ok: Boolean(activeSlot && slots[activeSlot].child),
    mode: "blue-green",
    activeSlot,
    generation,
    reloading,
    startedAt,
    slots: Object.fromEntries(Object.entries(slots).map(([name, slot]) => [name, {
      port: slot.port,
      pid: slot.child?.pid || null,
      phase: slot.phase,
      generation: slot.generation,
    }])),
  };
}

function requestWorker(slot, pathname, { method = "GET", timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: hubHost,
      port: slot.port,
      path: pathname,
      method,
      timeout,
      headers: { "x-hub-control-token": controlToken },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = text;
        try { body = JSON.parse(text); } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(body);
        else reject(new Error(`Worker ${slot.name} returned ${response.statusCode}: ${text}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Worker ${slot.name} timed out`)));
    request.on("error", reject);
    request.end();
  });
}

async function waitForWorker(slot, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!slot.child || slot.child.exitCode != null) throw new Error(`Worker ${slot.name} exited during startup`);
    try {
      const state = await requestWorker(slot, "/_worker/health", { timeout: 750 });
      slot.phase = state.phase;
      return state;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Worker ${slot.name} did not become healthy`);
}

async function stopWorker(slot) {
  const child = slot.child;
  if (!child) return;
  slot.intentional = true;
  try { await requestWorker(slot, "/_worker/deactivate", { method: "POST", timeout: 10_000 }); } catch {}
  if (child.exitCode == null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode == null) child.kill();
  slot.child = null;
  slot.phase = "offline";
}

async function spawnWorker(slot) {
  if (slot.child) await stopWorker(slot);
  generation += 1;
  slot.generation = generation;
  slot.intentional = false;
  const stdout = fs.openSync(path.join(hubHome, `worker-${slot.name}.stdout.log`), "a");
  const stderr = fs.openSync(path.join(hubHome, `worker-${slot.name}.stderr.log`), "a");
  const child = spawn(process.execPath, [workerScript], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: {
      ...process.env,
      CODEX_HUB_PORT: String(slot.port),
      CODEX_HUB_AUTOSTART: "0",
      CODEX_HUB_SLOT: slot.name,
      CODEX_HUB_CONTROL_TOKEN: controlToken,
      CODEX_HUB_PARENT_PID: String(process.pid),
    },
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  slot.child = child;
  slot.phase = "starting";
  child.on("exit", () => {
    const wasActive = activeSlot === slot.name;
    slot.child = null;
    slot.phase = "offline";
    if (!shuttingDown && !slot.intentional) {
      if (wasActive) void recoverActive(slot.name);
      else setTimeout(() => spawnWorker(slot).catch((error) => console.error(error)), 500);
    }
  });
  await waitForWorker(slot);
  return slot;
}

async function activateWorker(slot) {
  slot.phase = "starting";
  const state = await requestWorker(slot, "/_worker/activate", { method: "POST", timeout: 45_000 });
  slot.phase = state.phase;
  if (state.phase !== "active") throw new Error(`Worker ${slot.name} did not activate`);
}

async function recoverActive(failedName) {
  if (shuttingDown || reloading) return;
  reloading = true;
  const fallback = slots[failedName === "blue" ? "green" : "blue"];
  try {
    if (!fallback.child) await spawnWorker(fallback);
    await activateWorker(fallback);
    activeSlot = fallback.name;
    const failed = slots[failedName];
    await spawnWorker(failed);
  } catch (error) {
    console.error(`[supervisor] automatic failover failed: ${error.stack || error.message}`);
  } finally {
    reloading = false;
  }
}

async function hotReload() {
  if (reloading) throw new Error("A hub reload is already in progress");
  reloading = true;
  const old = slots[activeSlot];
  const next = slots[activeSlot === "blue" ? "green" : "blue"];
  try {
    await spawnWorker(next);
    await requestWorker(old, "/_worker/drain", { method: "POST" });
    old.phase = "draining";
    try {
      await activateWorker(next);
    } catch (error) {
      await requestWorker(old, "/_worker/resume", { method: "POST" }).catch(() => {});
      old.phase = "active";
      throw error;
    }
    activeSlot = next.name;
    await stopWorker(old);
    await spawnWorker(old);
    return serviceState();
  } finally {
    reloading = false;
  }
}

function proxyToActive(request, response) {
  const slot = activeSlot && slots[activeSlot];
  if (!slot?.child) return json(response, 503, { error: "Hub service is recovering" });
  const upstream = http.request({
    hostname: hubHost,
    port: slot.port,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, "x-forwarded-by": "codex-multi-supervisor" },
  }, (upstreamResponse) => {
    const headers = {
      ...upstreamResponse.headers,
      "x-hub-worker": slot.name,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    };
    response.writeHead(upstreamResponse.statusCode || 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) json(response, 502, { error: `Active hub worker unavailable: ${error.message}` });
    else response.destroy(error);
  });
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${hubHost}:${hubPort}`}`);
    if (request.method === "POST" && url.pathname === "/auth/login") {
      const body = await readBody(request);
      const contentType = String(request.headers["content-type"] || "");
      const password = contentType.includes("application/json")
        ? JSON.parse(body || "{}").password
        : new URLSearchParams(body).get("password");
      if (!passwordsMatch(password)) return json(response, 401, { error: "That password did not match." });
      const token = crypto.randomBytes(32).toString("base64url");
      sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
      const secure = String(request.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
      return json(response, 200, { ok: true }, { "set-cookie": `hub_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}` });
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const token = parseCookies(request).hub_session;
      if (token) sessions.delete(token);
      return json(response, 200, { ok: true }, { "set-cookie": "hub_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
    }
    if (!isAuthenticated(request)) {
      if (url.pathname === "/login.html" || url.pathname === "/login.css" || url.pathname === "/login.js") return proxyToActive(request, response);
      if (url.pathname.startsWith("/api/") || url.pathname === "/health") return json(response, 401, { error: "Authentication required" });
      response.writeHead(302, { location: "/login.html", "cache-control": "no-store" });
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/api/service") return json(response, 200, serviceState());
    if (url.pathname.startsWith("/_supervisor/")) {
      if (request.headers["x-hub-control-token"] !== controlToken) return json(response, 404, { error: "Not found" });
      if (request.method === "POST" && url.pathname === "/_supervisor/reload") return json(response, 200, await hotReload());
      if (request.method === "POST" && url.pathname === "/_supervisor/shutdown") {
        json(response, 200, { ok: true });
        setImmediate(() => shutdown("control"));
        return;
      }
      return json(response, 404, { error: "Not found" });
    }
    return proxyToActive(request, response);
  } catch (error) {
    return json(response, 500, { error: error.message });
  }
});

async function start() {
  await spawnWorker(slots.blue);
  await activateWorker(slots.blue);
  activeSlot = "blue";
  await spawnWorker(slots.green);
  server.listen(hubPort, hubHost, () => console.log(`Codex Multi supervisor listening on http://${hubHost}:${hubPort}`));
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Stopping supervisor (${signal})`);
  server.close();
  await Promise.allSettled(Object.values(slots).map(stopWorker));
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
await start();
