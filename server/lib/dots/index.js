'use strict';

/**
 * @fileoverview DOTS/ECS Main Export
 * 
 * Single entry point for the DOTS architecture.
 * Provides World, Components, Systems, and Query API.
 */

const { World, createWorld } = require('./world');
const components = require('./components');
const systems = require('./systems');

/**
 * Default world instance (singleton for server lifecycle)
 * @type {World|null}
 */
let defaultWorld = null;

/**
 * Get or create the default world
 * @returns {World}
 */
function getWorld() {
  if (!defaultWorld) {
    defaultWorld = new World();
  }
  return defaultWorld;
}

/**
 * Reset the default world (for testing)
 */
function resetWorld() {
  defaultWorld = null;
}

/**
 * Run a system with context
 * @param {World} world
 * @param {Function} system
 * @param {Object} [context]
 * @returns {World}
 */
function runSystem(world, system, context) {
  return system(world, context);
}

/**
 * Run multiple systems in sequence
 * @param {World} world
 * @param {Array<{system: Function, context?: Object}>} systemConfigs
 * @returns {World}
 */
function runSystems(world, systemConfigs) {
  for (const { system, context } of systemConfigs) {
    system(world, context);
  }
  return world;
}

/**
 * Query API - declarative data fetching
 * 
 * @param {World} world
 * @param {Object} query
 * @param {string[]} [query.agents] - fields to include for agents
 * @param {string[]} [query.tasks] - fields to include for tasks
 * @param {string[]} [query.terminals] - fields to include for terminals
 * @param {string[]} [query.floors] - fields to include for floors
 * @param {Function} [query.filterAgents] - filter function for agents
 * @param {Function} [query.filterTasks] - filter function for tasks
 * @returns {Object}
 */
function query(world, query) {
  const result = {};
  
  if (query.agents) {
    const fields = query.agents;
    const filter = query.filterAgents;
    result.agents = world.getAllAgents(filter).map(agent => {
      const picked = {};
      for (const field of fields) {
        if (field in agent) picked[field] = agent[field];
      }
      return picked;
    });
  }
  
  if (query.tasks) {
    const fields = query.tasks;
    const filter = query.filterTasks;
    result.tasks = world.getAllTasks(filter).map(task => {
      const picked = {};
      for (const field of fields) {
        if (field in task) picked[field] = task[field];
      }
      return picked;
    });
  }
  
  if (query.terminals) {
    const fields = query.terminals;
    const filter = query.filterTerminals;
    const terminals = [];
    for (const t of world.queryTerminals(filter)) {
      const picked = {};
      for (const field of fields) {
        if (field in t) picked[field] = t[field];
      }
      terminals.push(picked);
    }
    result.terminals = terminals;
  }
  
  if (query.floors) {
    const fields = query.floors;
    const filter = query.filterFloors;
    result.floors = world.getAllFloors(filter).map(floor => {
      const picked = {};
      for (const field of fields) {
        if (field in floor) picked[field] = floor[field];
      }
      return picked;
    });
  }
  
  return result;
}

/**
 * Build agent payload matching current /api/agents format
 * @param {World} world
 * @returns {Object}
 */
function buildAgentsPayload(world) {
  const agents = [];
  world.forEachAgent((idx, a) => {
    agents.push({
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
      evidence: a.evidence,
      status: a.currentTaskId ? 'working' : (a.sessionStatus?.toLowerCase() || a.display),
      host: a.host || null,
      host_stale: a.host_stale ?? false
    });
  });
  
  return {
    hive: process.env.OFFICE_HUD_HIVE || '',
    label: process.env.OFFICE_HUD_LABEL || 'Fleet hive',
    present: true,
    godId: 'god',
    agents
  };
}

module.exports = {
  World,
  createWorld,
  getWorld,
  resetWorld,
  runSystem,
  runSystems,
  query,
  buildAgentsPayload,
  components,
  systems
};