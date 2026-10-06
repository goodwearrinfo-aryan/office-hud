'use strict';

/**
 * @fileoverview Floor Systems - Pure functions for floor data processing
 */

const fs = require('fs');
const path = require('path');

/**
 * Read hive fleet.json
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
 * Read agent identity.md for responsibilities
 * @param {string} hivePath
 * @param {string} agentId
 * @returns {string[]}
 */
function readAgentResponsibilities(hivePath, agentId) {
  const identityPath = path.join(hivePath, 'agents', agentId, 'identity.md');
  try {
    const content = fs.readFileSync(identityPath, 'utf8');
    const resp = [];
    let grab = false;
    for (const line of content.splitlines()) {
      const t = line.trim();
      if (t.toLowerCase().startsWith('your responsibilities')) {
        grab = true;
        continue;
      }
      if (grab) {
        if (t.startsWith('- ')) {
          resp.push(t.slice(2).trim());
        } else if (t && !t.startsWith('-')) {
          break;
        }
      }
    }
    return resp;
  } catch {
    return [];
  }
}

/**
 * Get roster age from fleet.json mtime
 * @param {string} hivePath
 * @returns {{age_seconds: number|null, stale: boolean, observed_at: string|null}}
 */
function getRosterAge(hivePath) {
  const fleetPath = path.join(hivePath, 'fleet.json');
  try {
    const stat = fs.statSync(fleetPath);
    const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    return {
      age_seconds: ageSec,
      stale: ageSec > 3600,
      observed_at: new Date(stat.mtimeMs).toISOString()
    };
  } catch {
    return { age_seconds: null, stale: true, observed_at: null };
  }
}

/**
 * Floor Liveness System
 * Computes floor rollup from agents + responsibilities
 * 
 * @param {World} world
 * @param {Object} context
 * @param {string} context.hivePath
 * @returns {World}
 */
function floorLivenessSystem(world, context) {
  const { hivePath } = context;
  
  // Read hive data
  const fleetData = readFleet(hivePath);
  
  // Build floor map F1-F12
  const floorMap = new Map();
  for (let i = 1; i <= 12; i++) {
    const floorId = `floor:f${i}`;
    floorMap.set(floorId, {
      id: floorId,
      label: `F${i}`,
      manager: null,
      managerAlive: false,
      runtimeState: 'UNKNOWN',
      counters: { running: 0, working: 0, idle: 0, stale: 0, failed: 0, offline: 0, breaker: 0 },
      responsibilities: [],
      currentTask: null,
      lastActivity: null
    });
  }
  
  // Get agent display states from World
  const agents = world.getAllAgents();
  
  // Aggregate agents by floor
  for (const agent of agents) {
    const floorNum = agent.floor?.match(/^f(\d+)$/);
    if (!floorNum) continue;
    
    const floorId = `floor:f${floorNum[1]}`;
    const floor = floorMap.get(floorId);
    if (!floor) continue;
    
    // Count display states
    floor.counters[agent.display] = (floor.counters[agent.display] || 0) + 1;
    if (agent.display === 'busy') floor.counters.working++;
    
    // Track lead (first agent with manager role)
    if (!floor.manager && /floor\s*(lead|manager)/i.test(agent.role)) {
      floor.manager = agent.name;
      floor.managerAlive = agent.evidence?.processVerified === true;
    }
    
    // Track runtime state (most severe)
    const stateOrder = { breaker: 5, offline: 4, stale: 3, working: 2, busy: 2, idle: 1, UNKNOWN: 0 };
    const currentSeverity = stateOrder[floor.runtimeState] || 0;
    const agentSeverity = stateOrder[agent.display] || 0;
    if (agentSeverity > currentSeverity) {
      floor.runtimeState = agent.display;
    }
  }
  
  // Load responsibilities from identity.md for floor leads
  for (const [floorId, floor] of floorMap) {
    if (floor.manager) {
      // Find agent by name to get responsibilities
      for (const agent of fleetData.agents || []) {
        if (agent.name === floor.manager) {
          floor.responsibilities = readAgentResponsibilities(hivePath, agent.id);
          break;
        }
      }
    }
  }
  
  // Write floors to World
  for (const floor of floorMap.values()) {
    world.setFloor(floor);
  }
  
  return world;
}

/**
 * Floor Distinctness System
 * Computes Jaccard overlap of responsibilities (for hud_guard)
 * 
 * @param {World} world
 * @returns {World}
 */
function floorDistinctnessSystem(world) {
  // This is used by hud_guard.py which reads identity.md directly
  // World doesn't need to store this, but we could cache it
  return world;
}

/**
 * Build floors payload matching /api/floors format
 * 
 * @param {World} world
 * @returns {Object}
 */
function buildFloorsPayload(world) {
  const floors = world.getAllFloors();
  const counts = {};
  
  for (const floor of floors) {
    const floorId = floor.id.replace('floor:', '');
    counts[floorId] = {
      state: floor.runtimeState,
      manager_alive: floor.managerAlive,
      reason: floor.manager ? null : 'no manager assigned',
      current_task: floor.currentTask,
      last_activity: floor.lastActivity,
      tasks: floor.counters,
      workers: floor.counters.running + floor.counters.idle + floor.counters.working,
      failed_workers: floor.counters.failed,
      stalled: floor.counters.stale,
      degraded: floor.runtimeState === 'breaker' || floor.runtimeState === 'offline'
    };
  }
  
  return {
    floors,
    counts,
    summary: {
      total: floors.length,
      running: floors.reduce((sum, f) => sum + f.counters.running, 0),
      working: floors.reduce((sum, f) => sum + f.counters.working, 0),
      idle: floors.reduce((sum, f) => sum + f.counters.idle, 0),
      stale: floors.reduce((sum, f) => sum + f.counters.stale, 0),
      failed: floors.reduce((sum, f) => sum + f.counters.failed, 0),
      offline: floors.reduce((sum, f) => sum + f.counters.offline, 0),
      breaker: floors.reduce((sum, f) => sum + f.counters.breaker, 0)
    },
    source: 'DOTS',
    not_verified: false,
    at: Date.now()
  };
}

/**
 * Build summary payload matching /api/summary format
 * 
 * @param {World} world
 * @param {Object} context
 * @param {string} context.hivePath
 * @returns {Object}
 */
function buildSummaryPayload(world, context) {
  const { hivePath } = context;
  
  const agents = world.getAllAgents().map(a => ({
    id: a.id.replace('agent:', ''),
    name: a.name,
    role: a.role,
    floor: a.floor || null,
    isGod: a.role === 'god',
    provider: a.provider || null,
    model: a.model || null,
    cwd: a.cwd || null,
    cwdValid: a.cwdValid,
    display: a.display,
    archived: a.archived,
    breaker: a.breaker,
    tokens: a.tokens,
    usd: a.usd,
    capUsdPerDay: a.capUsdPerDay,
    capUsdPerMonth: a.capUsdPerMonth,
    sessionUsd: a.sessionUsd,
    lastTool: a.lastTool,
    lastActiveSecAgo: a.lastActiveSecAgo,
    inboxBacklog: a.inboxBacklog,
    onHold: a.onHold,
    lastSeen: a.lastSeen,
    sessionId: a.sessionId,
    sessionStatus: a.sessionStatus,
    processId: a.processId,
    heartbeatAgeSec: a.heartbeatAgeSec,
    sessionFresh: a.sessionFresh,
    currentTaskId: a.currentTaskId,
    currentTaskTitle: a.currentTaskTitle,
    evidence: a.evidence
  }));
  
  const floors = world.getAllFloors().map(f => ({
    floor: f.id.replace('floor:', ''),
    lead: f.manager,
    leadIsLive: f.managerAlive,
    agents: f.counters.running + f.counters.idle + f.counters.working + f.counters.stale + f.counters.offline + f.counters.breaker,
    running: f.counters.running,
    working: f.counters.working,
    idle: f.counters.idle,
    stale: f.counters.stale,
    failed: f.counters.failed,
    offline: f.counters.offline,
    breaker: f.counters.breaker,
    health: f.runtimeState
  }));
  
  const rosterAge = getRosterAge(hivePath);
  const fleet = { ...rosterAge, agents: agents.length };
  
  return {
    hive: hivePath,
    label: process.env.OFFICE_HUD_LABEL || 'Fleet hive',
    present: true,
    godId: 'god',
    agents,
    floors,
    fleet
  };
}

module.exports = {
  floorLivenessSystem,
  floorDistinctnessSystem,
  buildFloorsPayload,
  buildSummaryPayload,
  getRosterAge,
  readFleet,
  readAgentResponsibilities
};