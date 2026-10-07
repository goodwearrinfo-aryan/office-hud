'use strict';

/**
 * @fileoverview Systems Registry - Export all systems
 */

const agentSystem = require('./agentSystem');
const taskSystem = require('./taskSystem');
const terminalSystem = require('./terminalSystem');
const floorSystem = require('./floorSystem');

module.exports = {
  // Agent systems
  agentLivenessSystem: agentSystem.agentLivenessSystem,
  agentWorkEvidenceSystem: agentSystem.agentWorkEvidenceSystem,
  agentProcessVerificationSystem: agentSystem.agentProcessVerificationSystem,
  
  // Task systems
  taskRoutingSystem: taskSystem.taskRoutingSystem,
  taskVerdictSystem: taskSystem.taskVerdictSystem,
  buildQueueSummary: taskSystem.buildQueueSummary,
  buildTaskBoard: taskSystem.buildTaskBoard,
  buildFloorTaskCounts: taskSystem.buildFloorTaskCounts,
  
  // Terminal systems
  terminalSystem: terminalSystem.terminalSystem,
  buildTerminalHosts: terminalSystem.buildTerminalHosts,
  buildTerminalsPayload: terminalSystem.buildTerminalsPayload,
  buildTerminalsSpawnedPayload: terminalSystem.buildTerminalsSpawnedPayload,
  
  // Floor systems
  floorLivenessSystem: floorSystem.floorLivenessSystem,
  floorDistinctnessSystem: floorSystem.floorDistinctnessSystem,
  floorProbeSystem: floorSystem.floorProbeSystem,
  buildFloorsPayload: floorSystem.buildFloorsPayload,
  buildSummaryPayload: floorSystem.buildSummaryPayload,
  getRosterAge: floorSystem.getRosterAge,
  
  // Floor/Task helpers (legacy)
  buildFloorRollup: agentSystem.buildFloorRollup,
  getRosterAge: floorSystem.getRosterAge,
  
  // Terminal helpers
  redactEntry: terminalSystem.redactEntry,
  redactCommand: terminalSystem.redactCommand,
  redactAll: terminalSystem.redactAll,
  getSpawnPolicyAudit: terminalSystem.getSpawnPolicyAudit
};