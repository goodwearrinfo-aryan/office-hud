'use strict';

/**
 * @fileoverview DOTS Bridge - Integrates DOTS/ECS with existing office-hud server
 * 
 * This module provides drop-in replacements for resource producers.
 * Each function maintains the exact same output format for backward compatibility.
 */

const path = require('path');
const os = require('os');

const HIVE = process.env.OFFICE_HUD_HIVE || path.join(os.homedir(), 'openalice-fleet', 'hive');

const { getWorld, runSystems, buildAgentsPayload } = require('.');
const {
  agentLivenessSystem,
  agentWorkEvidenceSystem,
  agentProcessVerificationSystem,
  taskRoutingSystem,
  buildQueueSummary,
  buildTaskBoard,
  buildFloorTaskCounts,
  terminalSystem,
  buildTerminalsPayload,
  buildTerminalsSpawnedPayload,
  floorLivenessSystem,
  floorProbeSystem,
  buildFloorsPayload,
  buildSummaryPayload,
  getRosterAge
} = require('./systems');

/**
 * Common system runner for agent-based resources
 * @param {World} world
 */
function runAgentSystems(world) {
  runSystems(world, [
    { system: agentLivenessSystem, context: { hivePath: HIVE } },
    { system: agentWorkEvidenceSystem },
    { system: agentProcessVerificationSystem }
  ]);
}

/**
 * Common system runner for task-based resources
 * @param {World} world
 */
function runTaskSystems(world) {
  runSystems(world, [
    { system: taskRoutingSystem, context: { hivePath: HIVE } }
  ]);
}

/**
 * Common system runner for terminal-based resources
 * @param {World} world
 */
function runTerminalSystems(world) {
  runSystems(world, [
    { system: terminalSystem, context: { hivePath: HIVE } }
  ]);
}

/**
 * Common system runner for floor-based resources
 * @param {World} world
 */
function runFloorSystems(world) {
  runSystems(world, [
    { system: floorLivenessSystem, context: { hivePath: HIVE } },
    { system: agentLivenessSystem, context: { hivePath: HIVE } }, // Need agents for floor rollup
    { system: agentWorkEvidenceSystem },
    { system: agentProcessVerificationSystem }
  ]);
}

/**
 * Common system runner for floor probe (runs Python probe)
 * @param {World} world
 */
function runFloorProbeSystems(world) {
  runSystems(world, [
    { system: floorProbeSystem, context: { hivePath: HIVE } }
  ]);
}

// ==================== AGENTS ====================

/**
 * Produce agents payload (replaces mergedAgents())
 * @returns {Object} - { agents: [...] }
 */
function produceAgentsDots() {
  const world = getWorld();
  runAgentSystems(world);
  const payload = buildAgentsPayload(world);
  world.nextTick();
  return payload;
}

function getMergedAgentsDots() {
  return produceAgentsDots().agents;
}

// ==================== SUMMARY ====================

/**
 * Produce summary payload (replaces summary resource)
 * @returns {Object}
 */
function produceSummaryDots() {
  const world = getWorld();
  runFloorSystems(world);
  const payload = buildSummaryPayload(world, { hivePath: HIVE });
  world.nextTick();
  return payload;
}

// ==================== TASKS ====================

/**
 * Produce tasks payload
 * @returns {Object} - { tasks: [...] }
 */
function produceTasksDots() {
  const world = getWorld();
  runAgentSystems(world);
  runTaskSystems(world);
  
  const tasks = [];
  world.forEachTask((idx, t) => {
    tasks.push({
      task_id: t.id.replace('task:', ''),
      title: t.title,
      objective: t.objective,
      status: t.status,
      risk: t.risk,
      assigned_agent: t.assignedAgent?.replace('agent:', ''),
      claimed_by: t.claimedBy?.replace('agent:', ''),
      claimed_at: t.claimedAt ? new Date(t.claimedAt).toISOString() : null,
      result: t.result,
      floor: t.floorId.replace('floor:', '')
    });
  });
  
  world.nextTick();
  return { tasks };
}

/**
 * Produce task board payload
 * @returns {Object}
 */
function produceTaskBoardDots() {
  const world = getWorld();
  runAgentSystems(world);
  runTaskSystems(world);
  
  const payload = buildTaskBoard(world, 25);
  world.nextTick();
  return payload;
}

/**
 * Produce floor task counts payload
 * @returns {Object} - { counts: {...} }
 */
function produceFloorTaskCountsDots() {
  const world = getWorld();
  runAgentSystems(world);
  runTaskSystems(world);
  
  const payload = buildFloorTaskCounts(world);
  world.nextTick();
  return payload;
}

/**
 * Produce queue summary payload
 * @returns {Object}
 */
function produceQueueSummaryDots() {
  const world = getWorld();
  runAgentSystems(world);
  runTaskSystems(world);
  
  const payload = buildQueueSummary(world);
  world.nextTick();
  return payload;
}

// ==================== TERMINALS ====================

/**
 * Produce terminals payload
 * @returns {Object}
 */
function produceTerminalsDots() {
  const world = getWorld();
  runTerminalSystems(world);
  runAgentSystems(world); // Need agents for host mapping
  
  const payload = buildTerminalsPayload(world);
  world.nextTick();
  return payload;
}

/**
 * Produce terminals spawned payload
 * @returns {Object}
 */
function produceTerminalsSpawnedDots() {
  const world = getWorld();
  runTerminalSystems(world);
  
  const payload = buildTerminalsSpawnedPayload(world);
  world.nextTick();
  return payload;
}

// ==================== PROJECTS ====================

/**
 * Produce projects payload
 * @returns {Object} - { projects: [...] }
 */
function produceProjectsDots() {
  const world = getWorld();
  runAgentSystems(world);
  runTaskSystems(world);
  
  const projectsPath = path.join(HIVE, 'projects.json');
  let projectsData = { projects: [] };
  try {
    projectsData = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
  } catch {
    // File doesn't exist or is invalid
  }
  
  // Enhance projects with task counts from World
  const tasks = world.getAllTasks();
  const projectTaskCounts = {};
  for (const task of tasks) {
    const projectId = task.floorId?.replace('floor:', 'f') || 'unknown';
    projectTaskCounts[projectId] = (projectTaskCounts[projectId] || 0) + 1;
  }
  
  const projects = (projectsData.projects || []).map(p => ({
    ...p,
    task_count: projectTaskCounts[p.project_id] || 0
  }));
  
  const payload = { projects };
  return payload;
}

/**
 * Produce sessions payload
 * @returns {Object} - { sessions: [...] }
 */
function produceSessionsDots() {
  const now = Date.now();
  const SESSION_STALE_MS = 5 * 60 * 1000;
  
  const stamp = (session, extra = {}) => {
    const heartbeat = session.last_heartbeat ? Date.parse(session.last_heartbeat) : 
                     session.updated_at ? Date.parse(session.updated_at) : 
                     session.started_at ? Date.parse(session.started_at) : null;
    const heartbeatAgeSec = heartbeat == null ? null : Math.max(0, Math.floor((now - heartbeat) / 1000));
    const status = String(session.status || 'UNKNOWN').toUpperCase();
    const terminal = ['STOPPED', 'DEAD', 'ERROR', 'STALE'].includes(status);
    return {
      ...session,
      ...extra,
      heartbeat_age_sec: heartbeatAgeSec,
      fresh: heartbeatAgeSec != null && heartbeatAgeSec <= SESSION_STALE_MS / 1000 && !terminal,
    };
  };
  
  // Local sessions
  const sessionsPath = path.join(HIVE, 'sessions.json');
  let localSessions = { sessions: [] };
  try {
    localSessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  } catch {
    // File doesn't exist
  }
  
  // Remote sessions from terminal snapshot
  const { buildTerminalsPayload } = require('./systems');
  const terminalWorld = getWorld();
  runTerminalSystems(terminalWorld);
  const terminalData = buildTerminalsPayload(terminalWorld);
  const remoteSessions = terminalData.sessions || [];
  
  const sessions = [
    ...(localSessions.sessions || []).map(s => stamp(s, { host: s.host || require('os').hostname().split('.')[0] })),
    ...remoteSessions.map(s => stamp(s))
  ].sort((a, b) => {
    if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
    return (b.heartbeat_age_sec ?? Infinity) - (a.heartbeat_age_sec ?? Infinity);
  });
  
  return { sessions };
}

/**
 * Produce verify payload
 * @returns {Object}
 */
function produceVerifyDots() {
  const verifyPath = path.join(HIVE, 'verify_state.json');
  let st = null;
  try {
    st = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
  } catch {
    return { present: false };
  }
  
  const tally = st.verdict_tally || {};
  const scanned = (tally.OK || 0) + (tally.DODGE || 0) + (tally.SHORT || 0) + (tally.FAIL || 0) + (tally.EMPTY || 0);
  const outputQualityRatePct = scanned > 0 ? Math.round(((tally.OK || 0) / scanned) * 1000) / 10 : null;
  
  return {
    present: true,
    at: st.at,
    verdict_tally: tally,
    verdict_tally_total: scanned,
    requeued: st.requeued || [],
    quarantined: st.quarantined || [],
    outputQualityRatePct,
    verifiedWork: null,
    verifiedWorkDenominator: null,
    verificationCoverage: null,
    verificationBasis: 'no independent verifier and no artifact ledger: verdict ' +
      'tallies measure output quality, not whether work was real',
  };
}

// ==================== FLOORS ====================

/**
 * Produce floors payload (runs Python probe)
 * @returns {Object}
 */
function produceFloorsDots(hivePath) {
  const effectiveHivePath = hivePath || HIVE;
  const world = getWorld();
  runSystems(world, [
    { system: floorProbeSystem, context: { hivePath: effectiveHivePath } }
  ]);
  
  // We need to import buildFloorsPayload here since it's not in the require at top
  const { buildFloorsPayload } = require('./systems');
  const payload = buildFloorsPayload(world);
  world.nextTick();
  return payload;
}

/**
 * Produce summary payload (alternative to produceSummaryDots)
 * @returns {Object}
 */
function produceSummaryDotsAlt() {
  return produceSummaryDots();
}

module.exports = {
  // Agents
  produceAgentsDots,
  getMergedAgentsDots,
  
  // Summary
  produceSummaryDots,
  produceSummaryDotsAlt,
  
  // Tasks
  produceTasksDots,
  produceTaskBoardDots,
  produceFloorTaskCountsDots,
  produceQueueSummaryDots,
  
  // Terminals
  produceTerminalsDots,
  produceTerminalsSpawnedDots,
  
  // Projects
  produceProjectsDots,
  
  // Sessions
  produceSessionsDots,
  
  // Verify
  produceVerifyDots,
  
  // Floors
  produceFloorsDots
};