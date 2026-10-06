'use strict';

/**
 * @fileoverview Terminal Systems - Pure functions for terminal data processing
 */

const fs = require('fs');
const path = require('path');

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
 * Terminal System
 * Reads hive processes + fleet, computes terminal state, writes to World
 * 
 * @param {World} world
 * @param {Object} context
 * @param {string} context.hivePath
 * @returns {World}
 */
function terminalSystem(world, context) {
  const { hivePath } = context;
  
  // Read hive data
  const processesData = readProcesses(hivePath);
  const fleetData = readFleet(hivePath);
  const now = Date.now();
  
  // Build host map from fleet agents (each agent is a host)
  const hostMap = new Map();
  
  for (const agent of fleetData.agents || []) {
    if (!agent.id) continue;
    
    const hostId = `host:${agent.id}`;
    const hostName = agent.name || agent.id;
    const isLocal = agent.id === 'worker-a'; // Simplified
    
    if (!hostMap.has(hostId)) {
      hostMap.set(hostId, {
        id: hostId,
        name: hostName,
        local: isLocal,
        collectedAt: now,
        ageSec: 0,
        stale: false,
        processIds: []
      });
    }
  }
  
  // Add processes as terminals
  for (const proc of processesData.processes || []) {
    if (!proc.pid) continue;
    
    const termId = `terminal:proc-${proc.pid}`;
    const hostId = `host:local`; // All processes on this host for now
    
    const terminal = {
      id: termId,
      type: 'background',
      status: 'running',
      hostId: hostId,
      agentId: null,
      spawnedAt: now,
      projectId: proc.project_id || null,
      pid: proc.pid,
      command: proc.name || null,
      health: null
    };
    
    world.setTerminal(terminal);
    
    // Add to host
    const host = hostMap.get(hostId);
    if (host) {
      host.processIds.push(termId);
    }
  }
  
  // Write hosts
  for (const host of hostMap.values()) {
    world.setHost(host);
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
      }
    }
    
    const hostObj = {
      host: host.name,
      local: host.local,
      collected_at: host.collectedAt ? new Date(host.collectedAt).toISOString() : new Date().toISOString(),
      age_sec: host.ageSec,
      stale: host.stale,
      processes
    };
    
    hosts.push(hostObj);
    
    if (host.stale) {
      staleHosts.push(host.name);
    }
  }
  
  return {
    hosts,
    stale_hosts: staleHosts,
    terminals: [], // Legacy field
    sessions: [],  // Legacy field
    spawn_policy: { effect: 'permitted', summary: 'DOTS terminal system' }
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
  buildTerminalsPayload,
  buildTerminalsSpawnedPayload,
  readProcesses,
  readFleet
};