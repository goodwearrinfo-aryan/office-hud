/**
 * Bridge: export OpenAlice Runtime state to the format office-hud expects.
 * Reads from ~/.openalice and writes to ~/openalice-fleet/hive.
 */

const fs = require('fs');
const path = require('path');

const OPEN_HOME = process.env.OPENALICE_HOME || path.join(process.env.HOME, '.openalice');
const HIVE = process.env.OFFICE_HUD_HIVE || path.join(process.env.HOME, 'openalice-fleet', 'hive');

const STATE_DIR = path.join(OPEN_HOME, 'workspaces', 'state');
const DATA_STATE_DIR = path.join(OPEN_HOME, 'data', 'state');

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function exportProcesses() {
  // Build processes.json from openalice runtime state
  const runtime = readJsonSafe(path.join(OPEN_HOME, 'data', 'state', 'agent-runtime.jsonl'));
  const tasks = readJsonSafe(path.join(STATE_DIR, 'headless-tasks.json'));
  const agentRuntime = readJsonSafe(path.join(STATE_DIR, 'agent-runtime.jsonl'));
  
  const processes = [];
  const now = Date.now();
  
  // Add runtime process
  processes.push({
    pid: process.pid,
    command: 'openalice-runtime',
    args: [],
    startTime: now - 60000,
    live: true,
    collected_at: new Date().toISOString()
  });
  
  // Add headless tasks as processes
  if (tasks && tasks.tasks) {
    for (const t of tasks.tasks) {
      if (t.status === 'running' || t.status === 'pending') {
        processes.push({
          pid: null,
          command: 'headless-task',
          args: [t.taskId, t.agent, t.wsId],
          startTime: t.startedAt,
          live: true,
          collected_at: new Date().toISOString()
        });
      }
    }
  }
  
  return { processes, collected_at: new Date().toISOString() };
}

function exportRegistry() {
  // Build registry.json from workspace catalog
  const catalog = readJsonSafe(path.join(STATE_DIR, 'workspace-catalog.json'));
  const sessions = readJsonSafe(path.join(STATE_DIR, 'sessions', 'a31ee5a7-c1bc-45ae-8072-83989eb582e7.json'));
  
  const agents = {};
  if (catalog && catalog.workspaces) {
    for (const ws of catalog.workspaces) {
      if (ws.lifecycle === 'active') {
        agents[ws.id] = {
          id: ws.id,
          key: ws.key,
          displayName: ws.displayName,
          floor: ws.floor || 'f1',
          template: ws.template,
          active: true
        };
      }
    }
  }
  
  return { agents };
}

function main() {
  const procData = exportProcesses();
  const regData = exportRegistry();
  
  writeJson(path.join(HIVE, 'processes.json'), procData);
  writeJson(path.join(HIVE, 'registry.json'), regData);
  
  console.log(`Exported ${procData.processes.length} processes to ${HIVE}/processes.json`);
  console.log(`Exported ${Object.keys(regData.agents || {}).length} agents to ${HIVE}/registry.json`);
}

if (require.main === module) {
  main();
}

module.exports = { exportProcesses, exportRegistry };
