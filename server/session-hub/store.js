'use strict';

// Office-owned storage for the session hub.
//
// Three kinds of data live here and stay distinguishable, because a reader has
// to be able to tell an imported fact from a derived one:
//   sessions  - registry records, one per *provider* session. Identity is
//               (connector, native_id); two sessions are never merged because
//               their titles or repositories look similar.
//   events    - normalized, redacted transcript records. Each row carries the
//               provenance refs needed to jump back to the original file row or
//               database row it came from.
//   handoffs / audit / ingest_runs / checkpoints - office-owned bookkeeping.
//
// Nothing here is authoritative for the provider's own state: ingestion is
// read-only, so removing a row only removes the office's copy.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const HIVE = process.env.OFFICE_HUD_HIVE
  || path.join(os.homedir(), 'openalice-fleet', 'hive');
const DEFAULT_DB = process.env.SESSION_HUB_DB || path.join(HIVE, 'session-hub.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_key      TEXT PRIMARY KEY,
  connector        TEXT NOT NULL,
  native_id        TEXT NOT NULL,
  provider         TEXT NOT NULL,
  session_type     TEXT NOT NULL,
  title            TEXT,
  project_path     TEXT,
  workspace        TEXT,
  agent            TEXT,
  machine          TEXT,
  status           TEXT NOT NULL DEFAULT 'unknown',
  started_at       TEXT,
  last_activity_at TEXT,
  access_mode      TEXT NOT NULL DEFAULT 'read_only',
  sync_state       TEXT NOT NULL DEFAULT 'never',
  last_ingest_at   TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',
  bookmark         INTEGER NOT NULL DEFAULT 0,
  removed_at       TEXT,
  meta             TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  event_key             TEXT PRIMARY KEY,
  session_key           TEXT NOT NULL,
  connector             TEXT NOT NULL,
  native_event_id       TEXT,
  category              TEXT NOT NULL,
  role                  TEXT,
  human_input           INTEGER,
  data_type             TEXT,
  title                 TEXT,
  body                  TEXT,
  occurred_at           TEXT,
  occurred_at_precision TEXT NOT NULL DEFAULT 'unknown',
  evidence_refs         TEXT NOT NULL DEFAULT '[]',
  content_hash          TEXT NOT NULL,
  dedup_key             TEXT NOT NULL UNIQUE
);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title, body, content='events', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS checkpoints (
  connector  TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id               INTEGER PRIMARY KEY,
  connector        TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL DEFAULT 'running',
  sessions_seen    INTEGER NOT NULL DEFAULT 0,
  events_added     INTEGER NOT NULL DEFAULT 0,
  events_duplicate INTEGER NOT NULL DEFAULT 0,
  events_rejected  INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  detail           TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY,
  ts       TEXT NOT NULL,
  action   TEXT NOT NULL,
  subject  TEXT NOT NULL,
  actor    TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS handoffs (
  id             INTEGER PRIMARY KEY,
  created_at     TEXT NOT NULL,
  scope          TEXT NOT NULL,
  session_keys   TEXT NOT NULL,
  markdown       TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  unknowns       TEXT NOT NULL DEFAULT '[]',
  export_path    TEXT
);

CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_key, occurred_at);
CREATE INDEX IF NOT EXISTS events_category_idx ON events(category, occurred_at);
CREATE INDEX IF NOT EXISTS events_connector_idx ON events(connector, occurred_at);
CREATE INDEX IF NOT EXISTS sessions_connector_idx ON sessions(connector, last_activity_at);
`;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function openStore(dbPath = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec(SCHEMA);
  return { db, path: dbPath };
}

function sessionKey(connector, nativeId) {
  return `${connector}:${nativeId}`;
}

function upsertSession(db, record) {
  const key = record.session_key || sessionKey(record.connector, record.native_id);
  const existing = db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(key);
  const now = new Date().toISOString();
  const row = {
    session_key: key,
    connector: record.connector,
    native_id: record.native_id,
    provider: record.provider || record.connector,
    session_type: record.session_type || 'unknown',
    title: record.title ?? existing?.title ?? null,
    project_path: record.project_path ?? existing?.project_path ?? null,
    workspace: record.workspace ?? existing?.workspace ?? null,
    agent: record.agent ?? existing?.agent ?? null,
    machine: record.machine ?? existing?.machine ?? null,
    status: record.status ?? existing?.status ?? 'unknown',
    started_at: record.started_at ?? existing?.started_at ?? null,
    // Never walk activity backwards: a connector that re-reads an old file must
    // not make a live session look stale.
    last_activity_at: maxIso(record.last_activity_at, existing?.last_activity_at),
    access_mode: record.access_mode ?? existing?.access_mode ?? 'read_only',
    sync_state: record.sync_state ?? existing?.sync_state ?? 'never',
    last_ingest_at: now,
    tags: record.tags ? JSON.stringify(record.tags) : existing?.tags ?? '[]',
    bookmark: existing?.bookmark ?? 0,
    removed_at: existing?.removed_at ?? null,
    meta: record.meta ? JSON.stringify(record.meta) : existing?.meta ?? '{}',
  };
  if (existing) {
    db.prepare(`UPDATE sessions SET
        title=?, project_path=?, workspace=?, agent=?, machine=?, status=?,
        started_at=?, last_activity_at=?, sync_state=?, last_ingest_at=?, meta=?
      WHERE session_key=?`)
      .run(row.title, row.project_path, row.workspace, row.agent, row.machine,
        row.status, row.started_at, row.last_activity_at, row.sync_state,
        row.last_ingest_at, row.meta, key);
  } else {
    db.prepare(`INSERT INTO sessions (${Object.keys(row).join(',')})
        VALUES (${Object.keys(row).map(() => '?').join(',')})`)
      .run(...Object.values(row));
  }
  return key;
}

function insertEvent(db, event) {
  const dedupKey = event.dedup_key
    || `${event.connector}|${event.native_event_id ?? sha256(event.body ?? event.title ?? '')}`;
  const dup = db.prepare('SELECT 1 FROM events WHERE dedup_key = ?').get(dedupKey);
  if (dup) return { status: 'duplicate', dedup_key: dedup_key };

  const body = event.body ?? null;
  if (body === null && !event.title) return { status: 'rejected', reason: 'empty' };

  const row = {
    event_key: event.event_key || `${event.connector}:${event.session_key}|${dedupKey}`,
    session_key: event.session_key,
    connector: event.connector,
    native_event_id: event.native_event_id ?? null,
    category: event.category,
    role: event.role ?? null,
    human_input: event.human_input === undefined ? null : (event.human_input ? 1 : 0),
    data_type: event.data_type ?? null,
    title: event.title ?? null,
    body,
    occurred_at: event.occurred_at ?? null,
    occurred_at_precision: event.occurred_at_precision || 'unknown',
    evidence_refs: JSON.stringify(event.evidence_refs ?? []),
    content_hash: sha256(`${event.role}|${event.title}|${body}`),
    dedup_key: dedupKey,
  };
  db.prepare(`INSERT INTO events (${Object.keys(row).join(',')})
      VALUES (${Object.keys(row).map(() => '?').join(',')})`)
    .run(...Object.values(row));
  const rowid = db.prepare('SELECT rowid AS rid FROM events WHERE event_key = ?').get(row.event_key);
  db.prepare('INSERT INTO events_fts (rowid, title, body) VALUES (?, ?, ?)')
    .run(Number(rowid.rid), row.title ?? '', row.body ?? '');
  return { status: 'added', event_key: row.event_key };
}

function getCheckpoint(db, connector) {
  const row = db.prepare('SELECT cursor FROM checkpoints WHERE connector = ?').get(connector);
  return row ? JSON.parse(row.cursor) : null;
}

function setCheckpoint(db, connector, cursor) {
  db.prepare(`INSERT INTO checkpoints (connector, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(connector) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`)
    .run(connector, JSON.stringify(cursor), new Date().toISOString());
}

function startRun(db, connector) {
  const started_at = new Date().toISOString();
  db.prepare('INSERT INTO ingest_runs (connector, started_at) VALUES (?, ?)').run(connector, started_at);
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

function finishRun(db, id, fields) {
  db.prepare(`UPDATE ingest_runs SET finished_at=?, status=?, sessions_seen=?, events_added=?,
      events_duplicate=?, events_rejected=?, error=?, detail=? WHERE id=?`)
    .run(new Date().toISOString(), fields.status ?? 'ok', fields.sessions_seen ?? 0,
      fields.events_added ?? 0, fields.events_duplicate ?? 0, fields.events_rejected ?? 0,
      fields.error ?? null, JSON.stringify(fields.detail ?? {}), id);
}

function recordAudit(db, action, subject, actor, detail) {
  db.prepare('INSERT INTO audit (ts, action, subject, actor, detail) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), action, subject, actor ?? 'office', JSON.stringify(detail ?? {}));
}

function maxIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

module.exports = {
  DEFAULT_DB,
  HIVE,
  openStore,
  sessionKey,
  upsertSession,
  insertEvent,
  getCheckpoint,
  setCheckpoint,
  startRun,
  finishRun,
  recordAudit,
  sha256,
  maxIso,
};
