import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hubHome } from "./config.mjs";

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class HubStore {
  constructor(file = path.join(hubHome, "hub.sqlite")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        instance TEXT,
        type TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        payload TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        from_instance TEXT NOT NULL,
        from_thread_id TEXT,
        to_instance TEXT NOT NULL,
        to_thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        reason TEXT,
        priority TEXT NOT NULL,
        trigger_turn INTEGER NOT NULL,
        state TEXT NOT NULL,
        delivered_turn_id TEXT,
        error TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS intermediators (
        instance TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        role_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hosts (
        instance TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        role_version INTEGER NOT NULL,
        persona_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS host_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        initiator TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_turns INTEGER NOT NULL,
        turns_used INTEGER NOT NULL,
        max_searches INTEGER NOT NULL,
        searches_used INTEGER NOT NULL,
        ended_reason TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS host_actions (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        instance TEXT NOT NULL,
        type TEXT NOT NULL,
        target TEXT,
        text TEXT,
        tone TEXT,
        color TEXT,
        style TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        payload TEXT
      );

      CREATE TABLE IF NOT EXISTS host_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        instance TEXT NOT NULL,
        session_id TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at DESC);
      CREATE INDEX IF NOT EXISTS messages_target_idx
        ON messages(to_instance, to_thread_id, state, created_at);
      CREATE INDEX IF NOT EXISTS host_sessions_state_idx
        ON host_sessions(state, expires_at);
      CREATE INDEX IF NOT EXISTS host_actions_active_idx
        ON host_actions(expires_at, created_at);
      CREATE INDEX IF NOT EXISTS host_journal_created_idx
        ON host_journal(created_at DESC);
    `);
  }

  addEvent({ instance = null, type, threadId = null, turnId = null, payload = null }) {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO events(created_at, instance, type, thread_id, turn_id, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(createdAt, instance, type, threadId, turnId, json(payload));
    return Number(result.lastInsertRowid);
  }

  listEvents(limit = 100) {
    return this.db.prepare(`
      SELECT id, created_at, instance, type, thread_id, turn_id, payload
      FROM events ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      instance: row.instance,
      type: row.type,
      threadId: row.thread_id,
      turnId: row.turn_id,
      payload: parse(row.payload),
    }));
  }

  listThreadEvents(instance, threadId, limit = 100) {
    return this.db.prepare(`
      SELECT id, created_at, instance, type, thread_id, turn_id, payload
      FROM events
      WHERE instance = ? AND thread_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(instance, threadId, limit).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      instance: row.instance,
      type: row.type,
      threadId: row.thread_id,
      turnId: row.turn_id,
      payload: parse(row.payload),
    }));
  }

  createMessage(message) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO messages(
        id, created_at, updated_at, from_instance, from_thread_id,
        to_instance, to_thread_id, kind, body, reason, priority,
        trigger_turn, state, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      now,
      now,
      message.fromInstance,
      message.fromThreadId || null,
      message.toInstance,
      message.toThreadId,
      message.kind || "message",
      message.body,
      message.reason || null,
      message.priority || "normal",
      message.triggerTurn ? 1 : 0,
      message.state || "queued",
      json(message.metadata || {}),
    );
    return this.getMessage(message.id);
  }

  updateMessage(id, state, { turnId = null, error = null } = {}) {
    this.db.prepare(`
      UPDATE messages
      SET updated_at = ?, state = ?, delivered_turn_id = COALESCE(?, delivered_turn_id), error = ?
      WHERE id = ?
    `).run(new Date().toISOString(), state, turnId, error, id);
    return this.getMessage(id);
  }

  getMessage(id) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? this.#messageRow(row) : null;
  }

  listMessages({ limit = 100, state = null, instance = null, threadId = null } = {}) {
    const where = [];
    const params = [];
    if (state) { where.push("state = ?"); params.push(state); }
    if (instance) { where.push("to_instance = ?"); params.push(instance); }
    if (threadId) { where.push("to_thread_id = ?"); params.push(threadId); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);
    return this.db.prepare(`
      SELECT * FROM messages ${clause} ORDER BY created_at DESC LIMIT ?
    `).all(...params).map((row) => this.#messageRow(row));
  }

  listRelatedMessages(instance, threadId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE (from_instance = ? AND from_thread_id = ?)
         OR (to_instance = ? AND to_thread_id = ?)
      ORDER BY created_at DESC LIMIT ?
    `).all(instance, threadId, instance, threadId, limit)
      .map((row) => this.#messageRow(row));
  }

  queuedMessages(instance, threadId) {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE to_instance = ? AND to_thread_id = ? AND state = 'queued'
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at ASC
    `).all(instance, threadId).map((row) => this.#messageRow(row));
  }

  setIntermediator({ instance, threadId, model = null, reasoningEffort = null, roleVersion = 1 }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO intermediators(instance, thread_id, created_at, updated_at, model, reasoning_effort, role_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance) DO UPDATE SET
        thread_id = excluded.thread_id,
        updated_at = excluded.updated_at,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        role_version = excluded.role_version
    `).run(instance, threadId, now, now, model, reasoningEffort, roleVersion);
    return this.getIntermediator(instance);
  }

  getIntermediator(instance) {
    const row = this.db.prepare("SELECT * FROM intermediators WHERE instance = ?").get(instance);
    return row ? this.#intermediatorRow(row) : null;
  }

  listIntermediators() {
    return this.db.prepare("SELECT * FROM intermediators ORDER BY instance").all()
      .map((row) => this.#intermediatorRow(row));
  }

  setHost({ instance, threadId, model, reasoningEffort, roleVersion = 1, personaVersion = 1 }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO hosts(instance, thread_id, created_at, updated_at, model, reasoning_effort, role_version, persona_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance) DO UPDATE SET
        thread_id = excluded.thread_id,
        updated_at = excluded.updated_at,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        role_version = excluded.role_version,
        persona_version = excluded.persona_version
    `).run(instance, threadId, now, now, model, reasoningEffort, roleVersion, personaVersion);
    return this.getHost(instance);
  }

  getHost(instance) {
    const row = this.db.prepare("SELECT * FROM hosts WHERE instance = ?").get(instance);
    return row ? this.#hostRow(row) : null;
  }

  listHosts() {
    return this.db.prepare("SELECT * FROM hosts ORDER BY instance").all().map((row) => this.#hostRow(row));
  }

  createHostSession({ id, kind, initiator, expiresAt, maxTurns, maxSearches = 0, metadata = {} }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO host_sessions(
        id, kind, state, initiator, created_at, updated_at, expires_at,
        max_turns, turns_used, max_searches, searches_used, metadata
      ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, 0, ?)
    `).run(id, kind, initiator, now, now, expiresAt, maxTurns, maxSearches, json(metadata));
    return this.getHostSession(id);
  }

  getHostSession(id) {
    const row = this.db.prepare("SELECT * FROM host_sessions WHERE id = ?").get(id);
    return row ? this.#hostSessionRow(row) : null;
  }

  listHostSessions({ state = null, limit = 50 } = {}) {
    if (state) {
      return this.db.prepare("SELECT * FROM host_sessions WHERE state = ? ORDER BY created_at DESC LIMIT ?")
        .all(state, limit).map((row) => this.#hostSessionRow(row));
    }
    return this.db.prepare("SELECT * FROM host_sessions ORDER BY created_at DESC LIMIT ?")
      .all(limit).map((row) => this.#hostSessionRow(row));
  }

  reserveHostTurn(id) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE host_sessions
      SET turns_used = turns_used + 1, updated_at = ?
      WHERE id = ? AND state = 'active' AND expires_at > ? AND turns_used < max_turns
    `).run(now, id, now);
    return result.changes ? this.getHostSession(id) : null;
  }

  reserveHostSearch(id) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE host_sessions
      SET searches_used = searches_used + 1, updated_at = ?
      WHERE id = ? AND state = 'active' AND expires_at > ? AND searches_used < max_searches
    `).run(now, id, now);
    return result.changes ? this.getHostSession(id) : null;
  }

  finishHostSession(id, state = "complete", reason = null) {
    this.db.prepare(`
      UPDATE host_sessions SET state = ?, ended_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'active'
    `).run(state, reason, new Date().toISOString(), id);
    return this.getHostSession(id);
  }

  expireHostSessions() {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE host_sessions SET state = 'expired', ended_reason = COALESCE(ended_reason, 'session lease expired'), updated_at = ?
      WHERE state = 'active' AND expires_at <= ?
    `).run(now, now);
  }

  createHostAction({ id, sessionId = null, instance, type, target = null, text = null, tone = null, color = null, style = null, expiresAt, payload = {} }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO host_actions(id, session_id, instance, type, target, text, tone, color, style, created_at, expires_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, instance, type, target, text, tone, color, style, now, expiresAt, json(payload));
    return this.getHostAction(id);
  }

  getHostAction(id) {
    const row = this.db.prepare("SELECT * FROM host_actions WHERE id = ?").get(id);
    return row ? this.#hostActionRow(row) : null;
  }

  listActiveHostActions(at = new Date().toISOString()) {
    return this.db.prepare("SELECT * FROM host_actions WHERE expires_at > ? ORDER BY created_at ASC")
      .all(at).map((row) => this.#hostActionRow(row));
  }

  listHostActions(limit = 100) {
    return this.db.prepare("SELECT * FROM host_actions ORDER BY created_at DESC LIMIT ?")
      .all(limit).map((row) => this.#hostActionRow(row));
  }

  expireHostActions({ instance = null, sessionId = null, type = null } = {}) {
    const where = ["expires_at > ?"];
    const now = new Date().toISOString();
    const params = [now];
    if (instance) { where.push("instance = ?"); params.push(instance); }
    if (sessionId) { where.push("session_id = ?"); params.push(sessionId); }
    if (type) { where.push("type = ?"); params.push(type); }
    this.db.prepare(`UPDATE host_actions SET expires_at = ? WHERE ${where.join(" AND ")}`).run(now, ...params);
  }

  addHostJournal({ instance, sessionId = null, kind = "memory", text, metadata = {} }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO host_journal(created_at, instance, session_id, kind, text, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(now, instance, sessionId, kind, text, json(metadata));
    return Number(result.lastInsertRowid);
  }

  listHostJournal({ instance = null, limit = 40 } = {}) {
    if (instance) {
      return this.db.prepare("SELECT * FROM host_journal WHERE instance = ? ORDER BY id DESC LIMIT ?")
        .all(instance, limit).map((row) => this.#hostJournalRow(row));
    }
    return this.db.prepare("SELECT * FROM host_journal ORDER BY id DESC LIMIT ?")
      .all(limit).map((row) => this.#hostJournalRow(row));
  }

  setRuntimeState(key, value) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO runtime_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, json(value), now);
    return this.getRuntimeState(key);
  }

  getRuntimeState(key) {
    const row = this.db.prepare("SELECT key, value, updated_at FROM runtime_state WHERE key = ?").get(key);
    return row ? { key: row.key, value: parse(row.value), updatedAt: row.updated_at } : null;
  }

  #intermediatorRow(row) {
    return {
      instance: row.instance,
      threadId: row.thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      roleVersion: row.role_version,
    };
  }

  #hostRow(row) {
    return {
      instance: row.instance,
      threadId: row.thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      roleVersion: row.role_version,
      personaVersion: row.persona_version,
    };
  }

  #hostSessionRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      initiator: row.initiator,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      maxTurns: row.max_turns,
      turnsUsed: row.turns_used,
      maxSearches: row.max_searches,
      searchesUsed: row.searches_used,
      endedReason: row.ended_reason,
      metadata: parse(row.metadata) || {},
    };
  }

  #hostActionRow(row) {
    return {
      id: row.id,
      sessionId: row.session_id,
      instance: row.instance,
      type: row.type,
      target: row.target,
      text: row.text,
      tone: row.tone,
      color: row.color,
      style: row.style,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      payload: parse(row.payload) || {},
    };
  }

  #hostJournalRow(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
      instance: row.instance,
      sessionId: row.session_id,
      kind: row.kind,
      text: row.text,
      metadata: parse(row.metadata) || {},
    };
  }

  #messageRow(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      fromInstance: row.from_instance,
      fromThreadId: row.from_thread_id,
      toInstance: row.to_instance,
      toThreadId: row.to_thread_id,
      kind: row.kind,
      body: row.body,
      reason: row.reason,
      priority: row.priority,
      triggerTurn: Boolean(row.trigger_turn),
      state: row.state,
      deliveredTurnId: row.delivered_turn_id,
      error: row.error,
      metadata: parse(row.metadata) || {},
    };
  }

  close() {
    this.db.close();
  }
}
