'use strict';

/**
 * @fileoverview DOTS/ECS Component Definitions for Office HUD
 * 
 * Components are pure data (no methods). Defined via JSDoc for TypeScript consumers
 * and runtime validation. Each component maps to a column in the World's SoA store.
 * 
 * Entity = opaque string ID (format: 'agent:<id>', 'task:<id>', 'terminal:<id>', 'floor:<id>')
 */

/**
 * @typedef {string & {readonly __brand: unique symbol}} Entity
 */

/**
 * Agent component - maps to /api/agents payload + hud_guard evidence requirements
 * @typedef {Object} AgentComponent
 * @property {Entity} id
 * @property {string} name
 * @property {string} role
 * @property {string} floor
 * @property {string} provider
 * @property {string} model
 * @property {string} cwd
 * @property {boolean} cwdValid
 * @property {'busy'|'idle'|'stale'|'breaker'|'offline'} display
 * @property {boolean} archived
 * @property {string} breaker
 * @property {number} tokens
 * @property {number} usd
 * @property {number|null} capUsdPerDay
 * @property {number|null} capUsdPerMonth
 * @property {number} sessionUsd
 * @property {string|null} lastTool
 * @property {number|null} lastActiveSecAgo
 * @property {number} inboxBacklog
 * @property {boolean} onHold
 * @property {number|null} lastSeen
 * @property {string|null} sessionId
 * @property {string|null} sessionStatus
 * @property {number|null} processId
 * @property {number|null} heartbeatAgeSec
 * @property {boolean} sessionFresh
 * @property {string|null} currentTaskId
 * @property {string|null} currentTaskTitle
 * @property {Object} evidence
 * @property {boolean} evidence.hasSession
 * @property {boolean} evidence.sessionFresh
 * @property {boolean} evidence.hasTask
 * @property {string|null} evidence.taskStatus
 * @property {number|null} evidence.heartbeatAgeSec
 * @property {number|null} evidence.processId
 * @property {'alive'|'dead'|'no-pid'|null} evidence.processLiveness
 * @property {boolean} evidence.processVerified
 */

/**
 * Task component - maps to /api/tasks and /api/task-board
 * @typedef {Object} TaskComponent
 * @property {Entity} id
 * @property {string} title
 * @property {string} objective
 * @property {'QUEUED'|'CLAIMED'|'IN_PROGRESS'|'COMPLETE'|'FAILED'|'QUARANTINED'} status
 * @property {'low'|'destructive'} risk
 * @property {Entity|null} assignedAgent
 * @property {Entity|null} claimedBy
 * @property {number|null} claimedAt
 * @property {Entity} floorId
 * @property {string|null} result
 */

/**
 * Terminal component - maps to /api/terminals hosts/processes
 * @typedef {Object} TerminalComponent
 * @property {Entity} id
 * @property {'tmux'|'background'} type
 * @property {'starting'|'running'|'exited'} status
 * @property {Entity} hostId
 * @property {Entity|null} agentId
 * @property {number} spawnedAt
 * @property {string|null} projectId
 * @property {number|null} pid
 * @property {string|null} command
 * @property {string|null} health
 */

/**
 * Floor component - maps to /api/summary.floors + hud_guard liveness requirements
 * @typedef {Object} FloorComponent
 * @property {Entity} id
 * @property {string} label
 * @property {string} manager
 * @property {boolean} managerAlive
 * @property {string} runtimeState
 * @property {Object} counters
 * @property {number} counters.running
 * @property {number} counters.working
 * @property {number} counters.idle
 * @property {number} counters.stale
 * @property {number} counters.failed
 * @property {number} counters.offline
 * @property {number} counters.breaker
 * @property {string[]} responsibilities
 * @property {string|null} currentTask
 * @property {string|null} lastActivity
 */

/**
 * Host component - for terminal host aggregation
 * @typedef {Object} HostComponent
 * @property {Entity} id
 * @property {string} name
 * @property {boolean} local
 * @property {number} collectedAt
 * @property {number} ageSec
 * @property {boolean} stale
 * @property {Entity[]} processIds
 */

/**
 * Registry for component schemas - used by World for validation
 * @type {Map<string, Object>}
 */
const COMPONENT_SCHEMAS = new Map([
  ['Agent', {
    required: ['id', 'name', 'floor', 'display'],
    fields: {
      id: 'string', name: 'string', role: 'string', floor: 'string',
      provider: 'string', model: 'string', cwd: 'string', cwdValid: 'boolean',
      display: 'string', archived: 'boolean', breaker: 'string',
      tokens: 'number', usd: 'number', capUsdPerDay: 'number|null',
      capUsdPerMonth: 'number|null', sessionUsd: 'number', lastTool: 'string|null',
      lastActiveSecAgo: 'number|null', inboxBacklog: 'number', onHold: 'boolean',
      lastSeen: 'number|null', sessionId: 'string|null', sessionStatus: 'string|null',
      processId: 'number|null', heartbeatAgeSec: 'number|null', sessionFresh: 'boolean',
      currentTaskId: 'string|null', currentTaskTitle: 'string|null',
      evidence: 'object'
    }
  }],
  ['Task', {
    required: ['id', 'title', 'status'],
    fields: {
      id: 'string', title: 'string', objective: 'string', status: 'string',
      risk: 'string', assignedAgent: 'string|null', claimedBy: 'string|null',
      claimedAt: 'number|null', floorId: 'string', result: 'string|null'
    }
  }],
  ['Terminal', {
    required: ['id', 'type', 'status', 'hostId'],
    fields: {
      id: 'string', type: 'string', status: 'string', hostId: 'string',
      agentId: 'string|null', spawnedAt: 'number', projectId: 'string|null',
      pid: 'number|null', command: 'string|null', health: 'string|null'
    }
  }],
  ['Floor', {
    required: ['id', 'label', 'managerAlive', 'runtimeState'],
    fields: {
      id: 'string', label: 'string', manager: 'string', managerAlive: 'boolean',
      runtimeState: 'string', counters: 'object', responsibilities: 'array',
      currentTask: 'string|null', lastActivity: 'string|null'
    }
  }],
  ['Host', {
    required: ['id', 'name', 'local', 'ageSec'],
    fields: {
      id: 'string', name: 'string', local: 'boolean', collectedAt: 'number',
      ageSec: 'number', stale: 'boolean', processIds: 'array'
    }
  }]
]);

/**
 * Get component schema by name
 * @param {string} name
 * @returns {Object|undefined}
 */
function getComponentSchema(name) {
  return COMPONENT_SCHEMAS.get(name);
}

/**
 * Validate entity has required fields for component
 * @param {string} componentName
 * @param {Object} entity
 * @returns {string[]} - empty if valid, list of missing fields if invalid
 */
function validateComponent(componentName, entity) {
  const schema = COMPONENT_SCHEMAS.get(componentName);
  if (!schema) return [`Unknown component: ${componentName}`];
  const missing = [];
  for (const field of schema.required) {
    if (!(field in entity) || entity[field] === undefined || entity[field] === null) {
      missing.push(field);
    }
  }
  return missing;
}

module.exports = {
  COMPONENT_SCHEMAS,
  getComponentSchema,
  validateComponent,
  // Type re-exports for JSDoc consumers
  /** @type {Entity} */ Entity: '',
  /** @type {AgentComponent} */ AgentComponent: {},
  /** @type {TaskComponent} */ TaskComponent: {},
  /** @type {TerminalComponent} */ TerminalComponent: {},
  /** @type {FloorComponent} */ FloorComponent: {},
  /** @type {HostComponent} */ HostComponent: {}
};