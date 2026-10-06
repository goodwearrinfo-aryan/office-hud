'use strict';

/**
 * @fileoverview Agent Systems - Pure functions for agent data processing
 * 
 * Systems are pure functions: (World, context?) -> World
 * They read from hive files, compute derived state, and write to World.
 * No side effects, fully testable in isolation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Read hive registry.json
 * @param {string} hivePath
 * @returns {Object}
 */
function readRegistry(hivePath) {
  const registryPath = path.join(hivePath, 'registry.json');
  try {
    const data = fs.readFileSync(registryPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { agents: {}, godId: 'god' };
  }
}

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
 * Read hive tasks.json
 * @param {string} hivePath
 * @returns {Object}
 */
function readTasks(hivePath) {
  const tasksPath = path.join(hivePath, 'tasks.json');
  try {
    const data = fs.readFileSync(tasksPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { tasks: [] };
  }
}

/**
 * Read hive events.log (last N lines)
 * @param {string} hivePath
 * @param {number} maxLines
 * @returns {Array}
 */
function readRecentEvents(hivePath, maxLines = 1000) {
  const eventsPath = path.join(hivePath, 'events.log');
  try {
    const data = fs.readFileSync(eventsPath, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read agent identity.md
 * @param {string} hivePath
 * @param {string} agentId
 * @returns {string}
 */
function readAgentIdentity(hivePath, agentId) {
  const identityPath = path.join(hivePath, 'agents', agentId, 'identity.md');
  try {
    return fs.readFileSync(identityPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Check if a process ID is alive
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true; // exists but not ours
    return false;
  }
}

/**
 * Compute agent display status from raw fields
 * @param {Object} agent - raw agent from fleet.json
 * @param {Object} session - session info from events
 * @returns {'busy'|'idle'|'stale'|'breaker'|'offline'}
 */
function computeDisplay(agent, session) {
  if (agent.breaker === 'open') return 'breaker';
  if (!session) return 'offline';
  if (!session.fresh) return 'stale';
  if (session.hasTask) return 'busy';
  return 'idle';
}

/**
 * Compute agent evidence object (for hud_guard compliance)
 * @param {Object} agent
 * @param {Object} session
 * @param {number|null} processId
 * @param {number|null} heartbeatAgeSec
 * @param {string|null} currentTaskId
 * @param {string|null} currentTaskTitle
 * @returns {Object}
 */
function computeEvidence(agent, session, processId, heartbeatAgeSec, currentTaskId, currentTaskTitle) {
  const hasSession = !!session;
  const sessionFresh = session?.fresh === true;
  const hasTask = !!currentTaskId;
  const taskStatus = session?.taskStatus || null;
  const processLiveness = processId ? (isPidAlive(processId) ? 'alive' : 'dead') : 'no-pid';
  const processVerified = processId ? isPidAlive(processId) : false;

  return {
    hasSession,
    sessionFresh,
    hasTask,
    taskStatus,
    heartbeatAgeSec,
    processId,
    processLiveness,
    processVerified
  };
}

/**
 * Compute agent runtime state for floor rollup
 * @param {Object} agent
 * @param {Object} session
 * @returns {string}
 */
function computeRuntimeState(agent, session) {
  if (agent.breaker === 'open') return 'breaker';
  if (!session) return 'offline';
  if (!session.fresh) return 'stale';
  if (session.hasTask) return 'working';
  return 'idle';
}

/**
 * Agent Liveness System
 * Reads hive registry + fleet + events, computes agent state, writes to World
 * 
 * @param {World} world
 * @param {Object} context
 * @param {string} context.hivePath
 * @returns {World}
 */
function agentLivenessSystem(world, context) {
  const { hivePath } = context;
  
  // Read hive data
  const registry = readRegistry(hivePath);
  const fleet = readFleet(hivePath);
  const events = readRecentEvents(hivePath, 2000);
  
  // Build session map from recent events
  const sessions = new Map();
  const now = Date.now();
  
  for (const event of events) {
    if (!event.agent_id) continue;
    const agentId = event.agent_id;
    
    if (!sessions.has(agentId)) {
      sessions.set(agentId, {
        fresh: false,
        hasTask: false,
        taskStatus: null,
        lastHeartbeat: 0,
        heartbeatAgeSec: null
      });
    }
    
    const sess = sessions.get(agentId);
    
    if (event.type === 'heartbeat') {
      sess.lastHeartbeat = new Date(event.timestamp).getTime();
      sess.fresh = true;
    } else if (event.type === 'task_started') {
      sess.hasTask = true;
      sess.taskStatus = 'IN_PROGRESS';
    } else if (event.type === 'task_completed') {
      sess.hasTask = false;
      sess.taskStatus = 'COMPLETE';
    } else if (event.type === 'task_failed') {
      sess.hasTask = false;
      sess.taskStatus = 'FAILED';
    }
  }
  
  // Compute heartbeat age for each session
  for (const [agentId, sess] of sessions) {
    if (sess.lastHeartbeat) {
      sess.heartbeatAgeSec = Math.max(0, Math.floor((now - sess.lastHeartbeat) / 1000));
      // Session stale if no heartbeat in 5 minutes
      if (sess.heartbeatAgeSec > 300) {
        sess.fresh = false;
      }
    }
  }
  
  // Get process info from registry
  const registryAgents = registry.agents || {};
  
  // Process each agent from fleet.json (authoritative list)
  for (const fleetAgent of fleet.agents || []) {
    const agentId = fleetAgent.id;
    if (!agentId) continue;
    
    const entityId = `agent:${agentId}`;
    const regAgent = registryAgents[agentId] || {};
    const session = sessions.get(agentId) || { fresh: false, hasTask: false, taskStatus: null, heartbeatAgeSec: null };
    
    // Get process ID from registry
    const processId = regAgent.processId || fleetAgent.processId || null;
    
    // Get current task from session
    const currentTaskId = session.hasTask ? (/* would need task tracking */ null) : null;
    const currentTaskTitle = null; // would need task lookup
    
    // Build agent object for World
    const agent = {
      id: entityId,
      name: fleetAgent.name || agentId,
      role: fleetAgent.role || 'worker',
      floor: fleetAgent.floor || '',
      provider: fleetAgent.provider || '',
      model: fleetAgent.model || '',
      cwd: regAgent.cwd || '',
      cwdValid: regAgent.cwdValid !== false,
      display: computeDisplay(fleetAgent, session),
      archived: !!fleetAgent.archived,
      breaker: fleetAgent.breaker || 'closed',
      tokens: fleetAgent.tokens || 0,
      usd: fleetAgent.usd || 0,
      capUsdPerDay: fleetAgent.capUsdPerDay ?? null,
      capUsdPerMonth: fleetAgent.capUsdPerMonth ?? null,
      sessionUsd: fleetAgent.sessionUsd || 0,
      lastTool: regAgent.lastTool || null,
      lastActiveSecAgo: session.heartbeatAgeSec,
      inboxBacklog: regAgent.inboxBacklog || 0,
      onHold: !!regAgent.onHold,
      lastSeen: fleetAgent.lastSeen ? new Date(fleetAgent.lastSeen).getTime() : null,
      sessionId: regAgent.sessionId || null,
      sessionStatus: session.fresh ? 'active' : 'stale',
      processId: processId,
      heartbeatAgeSec: session.heartbeatAgeSec,
      sessionFresh: session.fresh,
      currentTaskId: currentTaskId,
      currentTaskTitle: currentTaskTitle,
      evidence: computeEvidence(fleetAgent, session, processId, session.heartbeatAgeSec, currentTaskId, currentTaskTitle)
    };
    
    world.setAgent(agent);
  }
  
  return world;
}

/**
 * Agent Work Evidence System
 * Computes work evidence fields for hud_guard compliance
 * 
 * @param {World} world
 * @returns {World}
 */
function agentWorkEvidenceSystem(world) {
  for (const agent of world.queryAgents()) {
    const evidence = agent.evidence || {};
    
    // Ensure evidence has all required fields for hud_guard
    agent.evidence = {
      ...evidence,
      hasSession: evidence.hasSession ?? false,
      sessionFresh: evidence.sessionFresh ?? false,
      hasTask: evidence.hasTask ?? false,
      taskStatus: evidence.taskStatus ?? null,
      heartbeatAgeSec: evidence.heartbeatAgeSec ?? null,
      processId: evidence.processId ?? null,
      processLiveness: evidence.processLiveness ?? 'no-pid',
      processVerified: evidence.processVerified ?? false
    };
    
    world.setAgent(agent); // update with complete evidence
  }
  
  return world;
}

/**
 * Agent Process Verification System
 * Verifies processId against live PIDs (hud_guard invariant 10)
 * 
 * @param {World} world
 * @returns {World}
 */
function agentProcessVerificationSystem(world) {
  for (const agent of world.queryAgents()) {
    const processId = agent.processId;
    const evidence = agent.evidence || {};
    
    if (processId) {
      const alive = isPidAlive(processId);
      evidence.processLiveness = alive ? 'alive' : 'dead';
      evidence.processVerified = alive;
    } else {
      evidence.processLiveness = 'no-pid';
      evidence.processVerified = false;
    }
    
    agent.evidence = evidence;
    world.setAgent(agent);
  }
  
  return world;
}

/**
 * Get agent roster age from fleet.json
 * @param {string} hivePath
 * @returns {{age_seconds: number|null, stale: boolean}}
 */
function getRosterAge(hivePath) {
  const fleetPath = path.join(hivePath, 'fleet.json');
  try {
    const stat = fs.statSync(fleetPath);
    const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    return { age_seconds: ageSec, stale: ageSec > 3600 }; // stale after 1 hour
  } catch {
    return { age_seconds: null, stale: true };
  }
}

/**
 * Build floor rollup from agents (for /api/summary.floors)
 * 
 * @param {World} world
 * @returns {Array}
 */
function buildFloorRollup(world) {
  const floorMap = new Map();
  
  // Initialize floors F1-F12
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
  
  // Aggregate agents by floor
  for (const agent of world.queryAgents()) {
    const floorNum = agent.floor?.match(/^f(\d+)$/);
    if (!floorNum) continue;
    
    const floorId = `floor:f${floorNum[1]}`;
    const floor = floorMap.get(floorId);
    if (!floor) continue;
    
    floor.counters[agent.display] = (floor.counters[agent.display] || 0) + 1;
    floor.counters.working += agent.display === 'busy' ? 1 : 0;
    
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
  
  // Load responsibilities from identity.md
  // (would need hivePath - skip for now, systems can be composed)
  
  return Array.from(floorMap.values());
}

module.exports = {
  agentLivenessSystem,
  agentWorkEvidenceSystem,
  agentProcessVerificationSystem,
  getRosterAge,
  buildFloorRollup,
  // Helpers for testing
  readRegistry,
  readFleet,
  readTasks,
  readRecentEvents,
  readAgentIdentity,
  isPidAlive,
  computeDisplay,
  computeEvidence,
  computeRuntimeState
};