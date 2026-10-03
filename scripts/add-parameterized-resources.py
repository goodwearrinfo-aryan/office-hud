#!/usr/bin/env python3
"""Add parameterized resources (agents/<id>, ledger/<source>) to office-hud.

Applied one edit at a time, writing and syntax-checking after each, because a
previous all-at-once run spliced out an unrelated region of the file.
"""
import subprocess
import sys

PATH = '/Users/a/trading/openalice-fleet/office-hud/server/index.js'


def read():
    with open(PATH, encoding='utf-8') as handle:
        return handle.read()


def write(source):
    with open(PATH, 'w', encoding='utf-8') as handle:
        handle.write(source)


def check():
    result = subprocess.run(['node', '--check', PATH], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr[:600], file=sys.stderr)
        raise SystemExit('SYNTAX ERROR — aborting before the next edit')


EDITS = []

# 1. agent detail as a producer, TTL-cached because it reads ~100 files
EDITS.append(("""app.get('/api/agents/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const agent = mergedAgents().find(item => item.id === id);
  if (!agent) return res.status(404).json({ error: 'agent not found', id });
  const dir = path.join(HIVE, 'agents', id);
  res.json({
    agent,
    identity: readText(path.join(dir, 'identity.md')),
    memory: readText(path.join(dir, 'memory.md')),
    inbox: listMessages(path.join(dir, 'inbox')),
    outbox: listMessages(path.join(dir, 'outbox')),
    sessions: sessionRows().filter(session => session.agent_id === id),
    currentTasks: (getTasks().tasks || []).filter(task => task.claimed_by === id && String(task.status).toUpperCase() === 'IN_PROGRESS'),
    recentEvents: getRecentEvents(1000).filter(event => event.agent_id === id).slice(0, 10),
  });
});""",
"""// The drawer reads up to ~100 files per agent (inbox and outbox), so the
// payload is briefly cached: a push is still live, just not re-derived several
// times a second on a busy hive.
const agentDetailCache = new Map();
const AGENT_DETAIL_TTL_MS = 2000;

function getAgentDetail(id) {
  const now = Date.now();
  const cached = agentDetailCache.get(id);
  if (cached && now - cached.at < AGENT_DETAIL_TTL_MS) return cached.value;
  const agent = mergedAgents().find(item => item.id === id);
  if (!agent) {
    agentDetailCache.delete(id);
    return null;
  }
  const dir = path.join(HIVE, 'agents', id);
  const value = {
    agent,
    identity: readText(path.join(dir, 'identity.md')),
    memory: readText(path.join(dir, 'memory.md')),
    inbox: listMessages(path.join(dir, 'inbox')),
    outbox: listMessages(path.join(dir, 'outbox')),
    sessions: sessionRows().filter(session => session.agent_id === id),
    currentTasks: (getTasks().tasks || []).filter(task => task.claimed_by === id && String(task.status).toUpperCase() === 'IN_PROGRESS'),
    recentEvents: getRecentEvents(1000).filter(event => event.agent_id === id).slice(0, 10),
  };
  agentDetailCache.set(id, { at: now, value });
  return value;
}

app.get('/api/agents/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const detail = getAgentDetail(id);
  if (!detail) return res.status(404).json({ error: 'agent not found', id });
  res.json(detail);
});""", 'agent detail producer'))


def main():
    for old, new, label in EDITS:
        source = read()
        count = source.count(old)
        if count != 1:
            print(f'FAIL [{label}]: {count} matches', file=sys.stderr)
            return 1
        write(source.replace(old, new))
        check()
        print('ok', label)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
