'use strict';

/**
 * @fileoverview Terminal Systems - Pure functions for terminal data processing
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Read hive processes.json
 * @param {string} hivePath
 * @returns {Object}
 */
function readProcesses(hivePath) {
  const processesPath = path.join(hivePath, 'processes.json');
  try {
    const data = fs.readFileSync(processesPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { processes: [] };
  }
}

/**
 * Read hive fleet.json for agent terminal info
 * @param {string} hivePath
 * @returns {Object}
 */
function readFleet(hivePath) {
  const fleetPath = path.join(hivePath, 'fleet.json');
  try {
    const data = fs.readFileSync(fleetPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { agents: [] };
  }
}

/**
 * Read local terminals.json
 * @param {string} hivePath
 * @returns {Object|null}
 */
function readLocalTerminals(hivePath) {
  const terminalsPath = path.join(hivePath, 'terminals.json');
  try {
    const data = fs.readFileSync(terminalsPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Read remote terminals for all hosts
 * @param {string} hivePath
 * @returns {Array} Array of { hostName, doc }
 */
function readRemoteTerminals(hivePath) {
  const remoteDir = path.join(hivePath, 'remote');
  const hosts = [];
  try {
    const entries = fs.readdirSync(remoteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(remoteDir, entry.name, 'terminals.json');
      try {
        const data = fs.readFileSync(file, 'utf8');
        const doc = JSON.parse(data);
        if (doc && typeof doc === 'object') {
          hosts.push({ hostName: String(doc.host || entry.name), doc });
        }
      } catch {
        continue; // corrupt or half-written: skip
      }
    }
  } catch {
    // no remote tree is a valid state
  }
  return hosts;
}

const TERMINAL_STALE_SEC = 5 * 60; // 5 minutes

/**
 * Build terminal hosts (local + remote) - mimics terminalHosts()
 * @param {string} hivePath
 * @returns {Array}
 */
function buildTerminalHosts(hivePath) {
  const hosts = [];
  const now = Date.now();
  
  // Local host
  const local = readLocalTerminals(hivePath);
  const localName = String(local?.host || os.hostname().split('.')[0]);
  hosts.push({
    host: localName,
    local: true,
    collected_at: local?.collected_at || null,
    age_sec: local?.collected_at ? Math.max(0, Math.round((now - Date.parse(local.collected_at)) / 1000)) : null,
    stale: false,
    doc: local || {}
  });
  
  // Remote hosts
  const remoteHosts = readRemoteTerminals(hivePath);
  for (const { hostName, doc } of remoteHosts) {
    const collectedAt = doc.collected_at || null;
    const ageSec = collectedAt ? Math.max(0, Math.round((now - Date.parse(collectedAt)) / 1000)) : null;
    hosts.push({
      host: hostName,
      local: false,
      collected_at: collectedAt,
      age_sec: ageSec,
      stale: ageSec == null || ageSec > TERMINAL_STALE_SEC,
      doc
    });
  }
  
  return hosts;
}

/**
 * Terminal System - reads local + remote terminals, writes to World
 * 
 * @param {World} world
 * @param {Object} context
 * @param {string} context.hivePath
 * @returns {World}
 */
function terminalSystem(world, context) {
  const { hivePath } = context;
  
  // Build hosts from hive
  const hosts = buildTerminalHosts(hivePath);
  
  // Write hosts to World
  for (const hostData of hosts) {
    const hostId = `host:${hostData.host}`;
    const now = Date.now();
    const collectedAt = hostData.collected_at ? Date.parse(hostData.collected_at) : now;
    const ageSec = hostData.age_sec ?? Math.round((now - collectedAt) / 1000);
    
    // Collect terminal IDs for this host
    const processIds = [];
    
    // Process shell_terminals
    const shellTerminals = Array.isArray(hostData.doc?.shell_terminals) ? hostData.doc.shell_terminals : [];
    for (const shell of shellTerminals) {
      const termId = `terminal:shell-${hostData.host}-${shell.pid || shell.id || Math.random()}`;
      const terminal = {
        id: termId,
        type: 'tmux',
        status: shell.status || 'running',
        hostId,
        agentId: null,
        spawnedAt: collectedAt,
        projectId: shell.project_id || null,
        pid: shell.pid || null,
        command: shell.cmd || (shell.argv && shell.argv[0]) || null,
        health: null
      };
      world.setTerminal(terminal);
      processIds.push(termId);
    }
    
    // Process agent_sessions
    const agentSessions = Array.isArray(hostData.doc?.agent_sessions) ? hostData.doc.agent_sessions : [];
    for (const session of agentSessions) {
      const termId = `terminal:session-${hostData.host}-${session.process_id || session.agent_id || Math.random()}`;
      const terminal = {
        id: termId,
        type: 'background',
        status: 'running',
        hostId,
        agentId: session.agent_id ? `agent:${session.agent_id}` : null,
        spawnedAt: collectedAt,
        projectId: session.project_id || null,
        pid: session.process_id || null,
        command: session.command || null,
        health: session.health || null
      };
      world.setTerminal(terminal);
      processIds.push(termId);
    }
    
    // Write host
    const hostObj = {
      id: hostId,
      name: hostData.host,
      local: hostData.local,
      collectedAt,
      ageSec,
      stale: hostData.stale,
      processIds
    };
    world.setHost(hostObj);
  }
  
  return world;
}

/**
 * Build terminals payload matching current /api/terminals format
 * 
 * @param {World} world
 * @returns {Object}
 */
function buildTerminalsPayload(world) {
  const hosts = [];
  const staleHosts = [];
  const terminals = [];
  const sessions = [];
  
  for (const host of world.queryHosts()) {
    const processes = [];
    
    for (const termId of host.processIds) {
      const term = world.getTerminalById?.(termId);
      if (term) {
        processes.push({
          process_id: term.pid ? String(term.pid) : null,
          project_id: term.projectId,
          command: term.command,
          status: term.status,
          health: term.health,
          pid: term.pid,
          started_at: term.spawnedAt ? new Date(term.spawnedAt).toISOString() : null,
          last_seen: null,
          restart_count: null
        });
        
        // Add to terminals array for legacy compatibility
        terminals.push({
          ...term,
          host: host.name,
          host_stale: host.stale,
          age_sec: host.ageSec
        });
      }
    }
    
    // Build redacted processes for host
    const redactedProcesses = processes.map(p => ({
      process_id: p.process_id,
      project_id: p.project_id,
      command: p.command ? redactCommand(p.command) : null,
      status: p.status,
      health: p.health,
      pid: p.pid,
      started_at: p.started_at,
      last_seen: p.last_seen,
      restart_count: p.restart_count
    }));
    
    const hostObj = {
      host: host.name,
      local: host.local,
      collected_at: host.collectedAt ? new Date(host.collectedAt).toISOString() : new Date().toISOString(),
      age_sec: host.ageSec,
      stale: host.stale,
      processes: redactedProcesses
    };
    
    hosts.push(hostObj);
    
    if (host.stale) {
      staleHosts.push(host.name);
    }
  }
  
  // Build legacy terminals and sessions arrays
  const legacyTerminals = terminals.map(t => redactEntry({
    ...t,
    host: t.hostId ? t.hostId.replace('host:', '') : '',
    host_stale: t.stale || false,
    age_sec: t.age_sec || 0
  }));
  
  const legacySessions = []; // Would need session data from World
  
  // Get spawn policy audit
  const spawnPolicy = getSpawnPolicyAudit();
  
  return {
    hosts,
    stale_hosts: staleHosts,
    terminals: legacyTerminals,
    sessions: legacySessions,
    spawn_policy: spawnPolicy
  };
}

/**
 * Redact a terminal entry (mimics redactEntry from lib/redact)
 * @param {Object} entry
 * @returns {Object}
 */
function redactEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const redacted = { ...entry };
  if (redacted.command) {
    redacted.command = redactCommand(redacted.command);
  }
  if (redacted.argv && Array.isArray(redacted.argv)) {
    redacted.argv = redacted.argv.map(redactCommand);
  }
  return redacted;
}

/**
 * Redact a command string
 * @param {string} cmd
 * @returns {string}
 */
function redactCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return cmd;
  // Redact common secret patterns
  return cmd
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_\-]{30,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9\-]{20,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED]');
}

/**
 * Redact all entries in an array
 * @param {Array} entries
 * @returns {Array}
 */
function redactAll(entries) {
  return Array.isArray(entries) ? entries.map(redactEntry) : [];
}

/**
 * Get spawn policy audit (mimics spawnPolicyAudit from index.js)
 * @returns {Object}
 */
function getSpawnPolicyAudit() {
  // This mimics the spawnPolicyAudit from index.js
  // For now, return a basic structure - the real audit reads from hive/terminal_allowlist.json
  return {
    source: 'DOTS terminal system',
    policy_path: 'hive/terminal_allowlist.json',
    policy_file_present: false,
    readable: false,
    error: 'Not implemented in DOTS yet',
    this_machine: require('os').hostname(),
    home: require('os').homedir(),
    permitted_trees: [],
    missing_trees: [],
    effect: 'permitted',
    summary: 'DOTS terminal system - policy audit not fully implemented'
  };
}

/**
 * Build terminals spawned payload (for /api/terminals/spawned)
 * 
 * @param {World} world
 * @returns {Object}
 */
function buildTerminalsSpawnedPayload(world) {
  const terminals = [];
  for (const term of world.queryTerminals()) {
    terminals.push({
      id: term.id.replace('terminal:', ''),
      type: term.type,
      status: term.status,
      cmd: term.command,
      argv: null,
      cwd: null,
      host: term.hostId.replace('host:', ''),
      name: term.command,
      pid: term.pid,
      tmuxSession: null,
      tmuxPane: null,
      startedAt: term.spawnedAt ? new Date(term.spawnedAt).toISOString() : null,
      exitedAt: null,
      exitCode: null,
      signal: null
    });
  }
  
  return {
    spawned: terminals,
    health: { hosts: 1, active: terminals.filter(t => t.status === 'running' || t.status === 'starting').length }
  };
}

module.exports = {
  terminalSystem,
  buildTerminalHosts,
  buildTerminalsPayload,
  buildTerminalsSpawnedPayload,
  readProcesses,
  readFleet,
  readLocalTerminals,
  readRemoteTerminals,
  redactEntry,
  redactCommand,
  redactAll,
  getSpawnPolicyAudit
};