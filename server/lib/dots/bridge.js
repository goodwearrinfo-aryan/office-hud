'use strict';

/**
 * @fileoverview DOTS Bridge - Integrates DOTS/ECS with existing office-hud server
 * 
 * This module provides drop-in replacements for resource producers.
 * Each function maintains the exact same output format for backward compatibility.
 */

const path = require('path');
const os = require('os');

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
  
  const tasks = world.getAllTasks().map(t => ({
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
  }));
  
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

// ==================== FLOORS ====================

/**
 * Produce floors payload
 * @returns {Object}
 */
function produceFloorsDots() {
  const world = getWorld();
  runFloorSystems(world);
  
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
  
  // Floors
  produceFloorsDots,
  
  HIVE
};