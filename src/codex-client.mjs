import { EventEmitter } from "node:events";

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ instance, url }) {
    super();
    this.instance = instance;
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.closing = false;
  }

  async connect() {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      await withTimeout(new Promise((resolve, reject) => {
        this.socket.addEventListener("open", resolve, { once: true });
        this.socket.addEventListener("error", reject, { once: true });
      }), 10_000, `${this.instance} websocket connect`);
      return;
    }

    this.closing = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => this.#onClose());
    socket.addEventListener("error", (event) => {
      if (!this.closing) this.emit("error", event.error || new Error("WebSocket error"));
    });

    await withTimeout(new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }), 10_000, `${this.instance} websocket connect`);

    await this.rpc("initialize", {
      clientInfo: {
        name: "codex_multi_hub",
        title: "Codex Multi Account Hub",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.connected = true;
    this.emit("connected");
  }

  async rpc(method, params = {}, timeoutMs = 45_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.instance} app server is not connected`);
    }
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ method, id, params }));
    return withTimeout(response, timeoutMs, `${this.instance} ${method}`).finally(() => this.pending.delete(id));
  }

  notify(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ method, params }));
  }

  close() {
    this.closing = true;
    this.socket?.close(1000, "hub shutdown");
    this.socket = null;
    this.connected = false;
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch (error) {
      this.emit("error", error);
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method) {
      if (Object.hasOwn(message, "id")) this.emit("request", message);
      else this.emit("notification", message.method, message.params || {});
    }
  }

  #onClose() {
    this.connected = false;
    for (const { reject } of this.pending.values()) reject(new Error(`${this.instance} app server disconnected`));
    this.pending.clear();
    if (!this.closing) this.emit("disconnected");
  }
}
