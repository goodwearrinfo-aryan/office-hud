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
  // Mimic original mergedAgents() logic: status field from fleet.json takes precedence
  const archived = !!agent.archived;
  const breaker = agent.breaker || (archived ? 'offline' : 'healthy');
  const hasWork = session?.hasTask === true;
  const sessionFresh = session?.fresh === true;
  
  // Check status field from fleet.json (set by tests and real agents)
  const status = agent.status || agent.display;
  if (status === 'busy') return 'busy';
  
  if (archived) return 'offline';
  if (breaker !== 'healthy') return 'breaker';
  if (hasWork) return 'busy';
  if (sessionFresh) return 'idle';
  if (session) return 'stale';
  return 'offline';
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
  // A local isPidAlive check of a REMOTE pid always reads 'dead' — the process
  // is not on this machine. When the remote merge attached host-verified
  // evidence (the remote host checked the PID itself), that evidence is the
  // trusted reading and the local check must not overwrite it with 'dead'.
  let processLiveness;
  let processVerified;
  if (session?.processLiveness) {
    processLiveness = session.processLiveness;
    processVerified = session.processLiveness === 'alive' || session.processLiveness === 'remote-verified';
  } else {
    processLiveness = processId ? (isPidAlive(processId) ? 'alive' : 'dead') : 'no-pid';
    processVerified = processId ? isPidAlive(processId) : false;
  }

  return {
    hasSession,
    sessionFresh,
    hasTask,
    taskStatus,
    heartbeatAgeSec,
    processId,
    processLiveness,
    processVerified,
    remoteHost: session?.remoteHost || null
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
        currentTaskId: null,
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
      sess.currentTaskId = event.task_id || null;
    } else if (event.type === 'task_completed') {
      sess.hasTask = false;
      sess.taskStatus = 'COMPLETE';
      sess.currentTaskId = null;
    } else if (event.type === 'task_failed') {
      sess.hasTask = false;
      sess.taskStatus = 'FAILED';
      sess.currentTaskId = null;
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

  // Merge remote-host agent sessions carrying host-verified process evidence.
  //
  // hive/remote/<host>/terminals.json holds each remote host's collected agent
  // sessions. The remote host's own collector stamps process_alive after
  // checking the PID directly on its machine (os.kill(pid, 0)) — that is the
  // trusted evidence the HUD truth standard demands, because a remote PID
  // string alone is a claim, not evidence. Only FRESH host docs are consulted
  // (a frozen remote doc is not evidence about now), a session older than the
  // stale window is skipped, and fresher LOCAL evidence always wins.
  // Local sessions.json is a second local source of truth that the events-derived
  // map above does not contain: the local hive's own heartbeat writers update it
  // directly. Comparing against the remote doc using only the event map would let
  // a remote session overwrite a FRESHER local record, so the local file is read
  // here purely for that comparison. It is not merged into the payload -- the
  // event-derived session stays authoritative for status.
  const localSessionsFreshest = new Map();
  try {
    const localDoc = JSON.parse(fs.readFileSync(path.join(hivePath, 'sessions.json'), 'utf8'));
    for (const s of Array.isArray(localDoc?.sessions) ? localDoc.sessions : []) {
      if (!s || typeof s !== 'object' || !s.agent_id) continue;
      const hb = s.last_heartbeat ? Date.parse(s.last_heartbeat) : 0;
      if (hb && hb > (localSessionsFreshest.get(s.agent_id) || 0)) {
        localSessionsFreshest.set(s.agent_id, hb);
      }
    }
  } catch { /* absent or unreadable local sessions is not an error here */ }

  const remoteDir = path.join(hivePath, 'remote');
  let remoteEntries = [];
  try { remoteEntries = fs.readdirSync(remoteDir, { withFileTypes: true }); } catch { remoteEntries = []; }
  for (const entry of remoteEntries) {
    if (!entry.isDirectory()) continue;
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(remoteDir, entry.name, 'terminals.json'), 'utf8')); } catch { continue; }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.agent_sessions)) continue;
    const collectedAt = doc.collected_at ? Date.parse(doc.collected_at) : NaN;
    const docFresh = Number.isFinite(collectedAt) && (Date.now() - collectedAt) / 1000 <= 300;
    if (!docFresh) continue;
    for (const s of doc.agent_sessions) {
      if (!s || typeof s !== 'object' || !s.agent_id) continue;
      const ageSec = s.heartbeat_age_sec != null
        ? s.heartbeat_age_sec
        : (s.last_heartbeat ? Math.max(0, Math.floor((Date.now() - Date.parse(s.last_heartbeat)) / 1000)) : null);
      if (ageSec == null || ageSec > 300) continue;
      const remoteHb = s.last_heartbeat ? Date.parse(s.last_heartbeat) : 0;
      const existing = sessions.get(s.agent_id);
      if (existing && existing.lastHeartbeat && existing.lastHeartbeat >= remoteHb && existing.lastHeartbeat > 0) continue;
      // ...and the same rule against the local hive's own sessions.json.
      if ((localSessionsFreshest.get(s.agent_id) || 0) >= remoteHb && remoteHb > 0) continue;
      const hostVerified = s.process_alive === true && !!s.pid_verified_by;
      sessions.set(s.agent_id, {
        fresh: true,
        hasTask: existing?.hasTask || false,
        taskStatus: existing?.taskStatus || null,
        currentTaskId: s.current_task_id || existing?.currentTaskId || null,
        lastHeartbeat: remoteHb || Date.now(),
        heartbeatAgeSec: ageSec,
        remote: true,
        remoteHost: entry.name,
        host: doc.host || entry.name,
        host_stale: !docFresh,
        remoteProcessId: (s.process_id != null ? s.process_id : existing?.remoteProcessId) || null,
        processLiveness: hostVerified ? 'remote-verified' : 'remote-unverified',
      });
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

    // DEBUG
    console.log('[AGENT DEBUG] agentId=' + agentId + ', session=' + JSON.stringify(session) + ', fleetAgent.processId=' + fleetAgent.processId);

    // Get process ID from registry. The remote merge may attach the real PID
    // reported by the remote host's collector (host-verified via process_alive)
    // when neither local source has one -- labeled in evidence.processLiveness,
    // never presented as locally verified.
    // Priority: remote session (live) > fleet.json (static) > registry (static)
    const processId = session.remoteProcessId || regAgent.processId || fleetAgent.processId || null;
    
    // Get current task from session (now tracked via events)
    const currentTaskId = session.currentTaskId || null;
    const currentTaskTitle = null; // would need task lookup
    
    // Build agent object for World
    // status field mimics original mergedAgents(): 'working' if has task, else session status or display
    const status = currentTaskId ? 'working' : (session?.status?.toLowerCase() || computeDisplay(fleetAgent, session));
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
      status: status,
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
      // Remote host provenance: which machine this agent's process actually runs on,
      // and whether that host's data is fresh. This distinguishes a local agent
      // (host = this machine, host_stale = false) from a remote agent whose
      // heartbeat comes from another machine's collector.
      host: session.host || null,
      host_stale: session.host_stale ?? false,
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

    // A host-verified remote reading must not be overwritten by a local check:
    // isPidAlive(remotePid) always reads 'dead' because the process is not on
    // this machine. 'remote-verified' means the remote host's own collector
    // checked the PID directly, which is the trusted evidence.
    const remoteReading = evidence.processLiveness === 'remote-verified'
      || evidence.processLiveness === 'remote-unverified';
    if (remoteReading) {
      agent.evidence = evidence;
      world.setAgent(agent);
      continue;
    }

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