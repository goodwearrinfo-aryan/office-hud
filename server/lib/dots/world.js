'use strict';

/**
 * @fileoverview World Store - Structure of Arrays (SoA) data store for DOTS/ECS
 * 
 * Cache-friendly layout: each component type stores arrays of field values.
 * Iteration is fast because we access contiguous memory for each field.
 * 
 * Example for Agent:
 *   agents = {
 *     ids: ['agent:a', 'agent:b'],
 *     names: ['Agent A', 'Agent B'],
 *     statuses: ['busy', 'idle'],
 *     ...
 *   }
 */

const { validateComponent } = require('./components');

/**
 * Create a new World with SoA stores for each component type
 * @returns {World}
 */
function createWorld() {
  return {
    // Component stores (SoA)
    agents: createAgentStore(),
    tasks: createTaskStore(),
    terminals: createTerminalStore(),
    floors: createFloorStore(),
    hosts: createHostStore(),
    
    // Entity -> component index mapping (for O(1) lookup)
    entityIndex: new Map(), // entityId -> { Agent: idx, Task: idx, ... }
    
    // Archetype bitmasks for fast queries
    // bit 0 = Agent, 1 = Task, 2 = Terminal, 3 = Floor, 4 = Host
    archetypes: new Map(), // entityId -> bitmask
    
    // Metadata
    _version: 0,
    _changed: new Set() // entityIds that changed this tick
  };
}

/**
 * Agent SoA store
 * @returns {Object}
 */
function createAgentStore() {
  return {
    ids: [],
    names: [],
    roles: [],
    floors: [],
    providers: [],
    models: [],
    cwds: [],
    cwdValids: [],
    displays: [],
    archiveds: [],
    breakers: [],
    tokens: [],
    usds: [],
    capUsdPerDays: [],
    capUsdPerMonths: [],
    sessionUsds: [],
    lastTools: [],
    lastActiveSecAgos: [],
    inboxBacklogs: [],
    onHolds: [],
    lastSeens: [],
    sessionIds: [],
    sessionStatuses: [],
    processIds: [],
    heartbeatAgeSecs: [],
    sessionFreshes: [],
    currentTaskIds: [],
    currentTaskTitles: [],
    evidence: []
  };
}

/**
 * Task SoA store
 * @returns {Object}
 */
function createTaskStore() {
  return {
    ids: [],
    titles: [],
    objectives: [],
    statuses: [],
    risks: [],
    assignedAgents: [],
    claimedBys: [],
    claimedAts: [],
    floorIds: [],
    results: []
  };
}

/**
 * Terminal SoA store
 * @returns {Object}
 */
function createTerminalStore() {
  return {
    ids: [],
    types: [],
    statuses: [],
    hostIds: [],
    agentIds: [],
    spawnedAts: [],
    projectIds: [],
    pids: [],
    commands: [],
    healths: []
  };
}

/**
 * Floor SoA store
 * @returns {Object}
 */
function createFloorStore() {
  return {
    ids: [],
    labels: [],
    managers: [],
    managerAlives: [],
    runtimeStates: [],
    counters: [],
    responsibilities: [],
    currentTasks: [],
    lastActivities: []
  };
}

/**
 * Host SoA store
 * @returns {Object}
 */
function createHostStore() {
  return {
    ids: [],
    names: [],
    locals: [],
    collectedAts: [],
    ageSecs: [],
    stales: [],
    processIds: []
  };
}

/**
 * World class - provides ergonomic API over SoA stores
 */
class World {
  constructor() {
    this.store = createWorld();
  }

  /** @returns {number} */
  get version() {
    return this.store._version;
  }

  /** Increment version and clear changed set */
  nextTick() {
    this.store._version++;
    this.store._changed.clear();
  }

  // ==================== ENTITY MANAGEMENT ====================

  /**
   * Get or create entity index
   * @param {string} entityId
   * @returns {Object}
   */
  _getEntityIndex(entityId) {
    let index = this.store.entityIndex.get(entityId);
    if (!index) {
      index = {};
      this.store.entityIndex.set(entityId, index);
    }
    return index;
  }

  /**
   * Set archetype bitmask for entity
   * @param {string} entityId
   * @param {number} mask
   */
  _setArchetype(entityId, mask) {
    this.store.archetypes.set(entityId, mask);
  }

  /**
   * Get archetype bitmask for entity
   * @param {string} entityId
   * @returns {number}
   */
  _getArchetype(entityId) {
    return this.store.archetypes.get(entityId) || 0;
  }

  /**
   * Mark entity as changed this tick
   * @param {string} entityId
   */
  _markChanged(entityId) {
    this.store._changed.add(entityId);
  }

  // ==================== AGENT OPERATIONS ====================

  /**
   * Add or update an agent
   * @param {Object} agent
   * @returns {number} index in store
   */
  setAgent(agent) {
    const missing = validateComponent('Agent', agent);
    if (missing.length) {
      throw new Error(`Agent missing required fields: ${missing.join(', ')}`);
    }

    const entityId = agent.id;
    const index = this._getEntityIndex(entityId);
    const store = this.store.agents;
    let idx = index.Agent;

    if (idx === undefined) {
      // New entity - append to all arrays
      idx = store.ids.length;
      index.Agent = idx;
      this._setArchetype(entityId, this._getArchetype(entityId) | 0b00001);
      
      store.ids.push(entityId);
      store.names.push(agent.name);
      store.roles.push(agent.role || '');
      store.floors.push(agent.floor || '');
      store.providers.push(agent.provider || '');
      store.models.push(agent.model || '');
      store.cwds.push(agent.cwd || '');
      store.cwdValids.push(!!agent.cwdValid);
      store.displays.push(agent.display || 'offline');
      store.archiveds.push(!!agent.archived);
      store.breakers.push(agent.breaker || '');
      store.tokens.push(agent.tokens || 0);
      store.usds.push(agent.usd || 0);
      store.capUsdPerDays.push(agent.capUsdPerDay ?? null);
      store.capUsdPerMonths.push(agent.capUsdPerMonth ?? null);
      store.sessionUsds.push(agent.sessionUsd || 0);
      store.lastTools.push(agent.lastTool || null);
      store.lastActiveSecAgos.push(agent.lastActiveSecAgo ?? null);
      store.inboxBacklogs.push(agent.inboxBacklog || 0);
      store.onHolds.push(!!agent.onHold);
      store.lastSeens.push(agent.lastSeen ?? null);
      store.sessionIds.push(agent.sessionId || null);
      store.sessionStatuses.push(agent.sessionStatus || null);
      store.processIds.push(agent.processId ?? null);
      store.heartbeatAgeSecs.push(agent.heartbeatAgeSec ?? null);
      store.sessionFreshes.push(!!agent.sessionFresh);
      store.currentTaskIds.push(agent.currentTaskId || null);
      store.currentTaskTitles.push(agent.currentTaskTitle || null);
      store.evidence.push(agent.evidence || {});
    } else {
      // Update existing
      store.names[idx] = agent.name;
      store.roles[idx] = agent.role || '';
      store.floors[idx] = agent.floor || '';
      store.providers[idx] = agent.provider || '';
      store.models[idx] = agent.model || '';
      store.cwds[idx] = agent.cwd || '';
      store.cwdValids[idx] = !!agent.cwdValid;
      store.displays[idx] = agent.display || 'offline';
      store.archiveds[idx] = !!agent.archived;
      store.breakers[idx] = agent.breaker || '';
      store.tokens[idx] = agent.tokens || 0;
      store.usds[idx] = agent.usd || 0;
      store.capUsdPerDays[idx] = agent.capUsdPerDay ?? null;
      store.capUsdPerMonths[idx] = agent.capUsdPerMonth ?? null;
      store.sessionUsds[idx] = agent.sessionUsd || 0;
      store.lastTools[idx] = agent.lastTool || null;
      store.lastActiveSecAgos[idx] = agent.lastActiveSecAgo ?? null;
      store.inboxBacklogs[idx] = agent.inboxBacklog || 0;
      store.onHolds[idx] = !!agent.onHold;
      store.lastSeens[idx] = agent.lastSeen ?? null;
      store.sessionIds[idx] = agent.sessionId || null;
      store.sessionStatuses[idx] = agent.sessionStatus || null;
      store.processIds[idx] = agent.processId ?? null;
      store.heartbeatAgeSecs[idx] = agent.heartbeatAgeSec ?? null;
      store.sessionFreshes[idx] = !!agent.sessionFresh;
      store.currentTaskIds[idx] = agent.currentTaskId || null;
      store.currentTaskTitles[idx] = agent.currentTaskTitle || null;
      store.evidence[idx] = agent.evidence || {};
    }

    this._markChanged(entityId);
    return idx;
  }

  /**
   * Get agent by index
   * @param {number} idx
   * @returns {Object|null}
   */
  getAgent(idx) {
    const store = this.store.agents;
    if (idx < 0 || idx >= store.ids.length) return null;
    return {
      id: store.ids[idx],
      name: store.names[idx],
      role: store.roles[idx],
      floor: store.floors[idx],
      provider: store.providers[idx],
      model: store.models[idx],
      cwd: store.cwds[idx],
      cwdValid: store.cwdValids[idx],
      display: store.displays[idx],
      archived: store.archiveds[idx],
      breaker: store.breakers[idx],
      tokens: store.tokens[idx],
      usd: store.usds[idx],
      capUsdPerDay: store.capUsdPerDays[idx],
      capUsdPerMonth: store.capUsdPerMonths[idx],
      sessionUsd: store.sessionUsds[idx],
      lastTool: store.lastTools[idx],
      lastActiveSecAgo: store.lastActiveSecAgos[idx],
      inboxBacklog: store.inboxBacklogs[idx],
      onHold: store.onHolds[idx],
      lastSeen: store.lastSeens[idx],
      sessionId: store.sessionIds[idx],
      sessionStatus: store.sessionStatuses[idx],
      processId: store.processIds[idx],
      heartbeatAgeSec: store.heartbeatAgeSecs[idx],
      sessionFresh: store.sessionFreshes[idx],
      currentTaskId: store.currentTaskIds[idx],
      currentTaskTitle: store.currentTaskTitles[idx],
      evidence: store.evidence[idx]
    };
  }

  /**
   * Get agent by entity ID
   * @param {string} entityId
   * @returns {Object|null}
   */
  getAgentById(entityId) {
    const index = this.store.entityIndex.get(entityId);
    if (!index || index.Agent === undefined) return null;
    return this.getAgent(index.Agent);
  }

  /**
   * Iterate all agents with optional filter
   * @param {Function} [filterFn] - (agent) => boolean
   * @returns {Generator<Object>}
   */
  *queryAgents(filterFn) {
    const store = this.store.agents;
    for (let i = 0; i < store.ids.length; i++) {
      const agent = this.getAgent(i);
      if (!filterFn || filterFn(agent)) {
        yield agent;
      }
    }
  }

  /**
   * Get all agents as array
   * @param {Function} [filterFn]
   * @returns {Object[]}
   */
  getAllAgents(filterFn) {
    return [...this.queryAgents(filterFn)];
  }

  /**
   * Get agent count
   * @returns {number}
   */
  get agentCount() {
    return this.store.agents.ids.length;
  }

  // ==================== TASK OPERATIONS ====================

  /**
   * Add or update a task
   * @param {Object} task
   * @returns {number} index in store
   */
  setTask(task) {
    const missing = validateComponent('Task', task);
    if (missing.length) {
      throw new Error(`Task missing required fields: ${missing.join(', ')}`);
    }

    const entityId = task.id;
    const index = this._getEntityIndex(entityId);
    const store = this.store.tasks;
    let idx = index.Task;

    if (idx === undefined) {
      idx = store.ids.length;
      index.Task = idx;
      this._setArchetype(entityId, this._getArchetype(entityId) | 0b00010);

      store.ids.push(entityId);
      store.titles.push(task.title);
      store.objectives.push(task.objective || '');
      store.statuses.push(task.status);
      store.risks.push(task.risk || 'low');
      store.assignedAgents.push(task.assignedAgent || null);
      store.claimedBys.push(task.claimedBy || null);
      store.claimedAts.push(task.claimedAt ?? null);
      store.floorIds.push(task.floorId || '');
      store.results.push(task.result || null);
    } else {
      store.titles[idx] = task.title;
      store.objectives[idx] = task.objective || '';
      store.statuses[idx] = task.status;
      store.risks[idx] = task.risk || 'low';
      store.assignedAgents[idx] = task.assignedAgent || null;
      store.claimedBys[idx] = task.claimedBy || null;
      store.claimedAts[idx] = task.claimedAt ?? null;
      store.floorIds[idx] = task.floorId || '';
      store.results[idx] = task.result || null;
    }

    this._markChanged(entityId);
    return idx;
  }

  /**
   * Get task by index
   * @param {number} idx
   * @returns {Object|null}
   */
  getTask(idx) {
    const store = this.store.tasks;
    if (idx < 0 || idx >= store.ids.length) return null;
    return {
      id: store.ids[idx],
      title: store.titles[idx],
      objective: store.objectives[idx],
      status: store.statuses[idx],
      risk: store.risks[idx],
      assignedAgent: store.assignedAgents[idx],
      claimedBy: store.claimedBys[idx],
      claimedAt: store.claimedAts[idx],
      floorId: store.floorIds[idx],
      result: store.results[idx]
    };
  }

  /**
   * Iterate all tasks with optional filter
   * @param {Function} [filterFn]
   * @returns {Generator<Object>}
   */
  *queryTasks(filterFn) {
    const store = this.store.tasks;
    for (let i = 0; i < store.ids.length; i++) {
      const task = this.getTask(i);
      if (!filterFn || filterFn(task)) {
        yield task;
      }
    }
  }

  /**
   * Get all tasks as array
   * @param {Function} [filterFn]
   * @returns {Object[]}
   */
  getAllTasks(filterFn) {
    return [...this.queryTasks(filterFn)];
  }

  // ==================== TERMINAL OPERATIONS ====================

  /**
   * Add or update a terminal
   * @param {Object} terminal
   * @returns {number} index in store
   */
  setTerminal(terminal) {
    const missing = validateComponent('Terminal', terminal);
    if (missing.length) {
      throw new Error(`Terminal missing required fields: ${missing.join(', ')}`);
    }

    const entityId = terminal.id;
    const index = this._getEntityIndex(entityId);
    const store = this.store.terminals;
    let idx = index.Terminal;

    if (idx === undefined) {
      idx = store.ids.length;
      index.Terminal = idx;
      this._setArchetype(entityId, this._getArchetype(entityId) | 0b00100);

      store.ids.push(entityId);
      store.types.push(terminal.type);
      store.statuses.push(terminal.status);
      store.hostIds.push(terminal.hostId);
      store.agentIds.push(terminal.agentId || null);
      store.spawnedAts.push(terminal.spawnedAt);
      store.projectIds.push(terminal.projectId || null);
      store.pids.push(terminal.pid ?? null);
      store.commands.push(terminal.command || null);
      store.healths.push(terminal.health || null);
    } else {
      store.types[idx] = terminal.type;
      store.statuses[idx] = terminal.status;
      store.hostIds[idx] = terminal.hostId;
      store.agentIds[idx] = terminal.agentId || null;
      store.spawnedAts[idx] = terminal.spawnedAt;
      store.projectIds[idx] = terminal.projectId || null;
      store.pids[idx] = terminal.pid ?? null;
      store.commands[idx] = terminal.command || null;
      store.healths[idx] = terminal.health || null;
    }

    this._markChanged(entityId);
    return idx;
  }

  /**
   * Get terminal by index
   * @param {number} idx
   * @returns {Object|null}
   */
  getTerminal(idx) {
    const store = this.store.terminals;
    if (idx < 0 || idx >= store.ids.length) return null;
    return {
      id: store.ids[idx],
      type: store.types[idx],
      status: store.statuses[idx],
      hostId: store.hostIds[idx],
      agentId: store.agentIds[idx],
      spawnedAt: store.spawnedAts[idx],
      projectId: store.projectIds[idx],
      pid: store.pids[idx],
      command: store.commands[idx],
      health: store.healths[idx]
    };
  }

  /**
   * Iterate all terminals with optional filter
   * @param {Function} [filterFn]
   * @returns {Generator<Object>}
   */
  *queryTerminals(filterFn) {
    const store = this.store.terminals;
    for (let i = 0; i < store.ids.length; i++) {
      const terminal = this.getTerminal(i);
      if (!filterFn || filterFn(terminal)) {
        yield terminal;
      }
    }
  }

  // ==================== FLOOR OPERATIONS ====================

  /**
   * Add or update a floor
   * @param {Object} floor
   * @returns {number} index in store
   */
  setFloor(floor) {
    const missing = validateComponent('Floor', floor);
    if (missing.length) {
      throw new Error(`Floor missing required fields: ${missing.join(', ')}`);
    }

    const entityId = floor.id;
    const index = this._getEntityIndex(entityId);
    const store = this.store.floors;
    let idx = index.Floor;

    if (idx === undefined) {
      idx = store.ids.length;
      index.Floor = idx;
      this._setArchetype(entityId, this._getArchetype(entityId) | 0b01000);

      store.ids.push(entityId);
      store.labels.push(floor.label);
      store.managers.push(floor.manager || '');
      store.managerAlives.push(!!floor.managerAlive);
      store.runtimeStates.push(floor.runtimeState || 'UNKNOWN');
      store.counters.push(floor.counters || { running: 0, working: 0, idle: 0, stale: 0, failed: 0, offline: 0, breaker: 0 });
      store.responsibilities.push(floor.responsibilities || []);
      store.currentTasks.push(floor.currentTask || null);
      store.lastActivities.push(floor.lastActivity || null);
    } else {
      store.labels[idx] = floor.label;
      store.managers[idx] = floor.manager || '';
      store.managerAlives[idx] = !!floor.managerAlive;
      store.runtimeStates[idx] = floor.runtimeState || 'UNKNOWN';
      store.counters[idx] = floor.counters || { running: 0, working: 0, idle: 0, stale: 0, failed: 0, offline: 0, breaker: 0 };
      store.responsibilities[idx] = floor.responsibilities || [];
      store.currentTasks[idx] = floor.currentTask || null;
      store.lastActivities[idx] = floor.lastActivity || null;
    }

    this._markChanged(entityId);
    return idx;
  }

  /**
   * Get floor by index
   * @param {number} idx
   * @returns {Object|null}
   */
  getFloor(idx) {
    const store = this.store.floors;
    if (idx < 0 || idx >= store.ids.length) return null;
    return {
      id: store.ids[idx],
      label: store.labels[idx],
      manager: store.managers[idx],
      managerAlive: store.managerAlives[idx],
      runtimeState: store.runtimeStates[idx],
      counters: store.counters[idx],
      responsibilities: store.responsibilities[idx],
      currentTask: store.currentTasks[idx],
      lastActivity: store.lastActivities[idx]
    };
  }

  /**
   * Iterate all floors with optional filter
   * @param {Function} [filterFn]
   * @returns {Generator<Object>}
   */
  *queryFloors(filterFn) {
    const store = this.store.floors;
    for (let i = 0; i < store.ids.length; i++) {
      const floor = this.getFloor(i);
      if (!filterFn || filterFn(floor)) {
        yield floor;
      }
    }
  }

  /**
   * Get all floors as array (sorted by floor number)
   * @param {Function} [filterFn]
   * @returns {Object[]}
   */
  getAllFloors(filterFn) {
    const floors = [...this.queryFloors(filterFn)];
    return floors.sort((a, b) => {
      const an = parseInt(a.id.replace('floor:', '').replace('f', ''), 10);
      const bn = parseInt(b.id.replace('floor:', '').replace('f', ''), 10);
      return an - bn;
    });
  }

  // ==================== HOST OPERATIONS ====================

  /**
   * Add or update a host
   * @param {Object} host
   * @returns {number} index in store
   */
  setHost(host) {
    const missing = validateComponent('Host', host);
    if (missing.length) {
      throw new Error(`Host missing required fields: ${missing.join(', ')}`);
    }

    const entityId = host.id;
    const index = this._getEntityIndex(entityId);
    const store = this.store.hosts;
    let idx = index.Host;

    if (idx === undefined) {
      idx = store.ids.length;
      index.Host = idx;
      this._setArchetype(entityId, this._getArchetype(entityId) | 0b10000);

      store.ids.push(entityId);
      store.names.push(host.name);
      store.locals.push(!!host.local);
      store.collectedAts.push(host.collectedAt);
      store.ageSecs.push(host.ageSec);
      store.stales.push(!!host.stale);
      store.processIds.push(host.processIds || []);
    } else {
      store.names[idx] = host.name;
      store.locals[idx] = !!host.local;
      store.collectedAts[idx] = host.collectedAt;
      store.ageSecs[idx] = host.ageSec;
      store.stales[idx] = !!host.stale;
      store.processIds[idx] = host.processIds || [];
    }

    this._markChanged(entityId);
    return idx;
  }

  /**
   * Get host by index
   * @param {number} idx
   * @returns {Object|null}
   */
  getHost(idx) {
    const store = this.store.hosts;
    if (idx < 0 || idx >= store.ids.length) return null;
    return {
      id: store.ids[idx],
      name: store.names[idx],
      local: store.locals[idx],
      collectedAt: store.collectedAts[idx],
      ageSec: store.ageSecs[idx],
      stale: store.stales[idx],
      processIds: store.processIds[idx]
    };
  }

  /**
   * Iterate all hosts with optional filter
   * @param {Function} [filterFn]
   * @returns {Generator<Object>}
   */
  *queryHosts(filterFn) {
    const store = this.store.hosts;
    for (let i = 0; i < store.ids.length; i++) {
      const host = this.getHost(i);
      if (!filterFn || filterFn(host)) {
        yield host;
      }
    }
  }

  // ==================== OPTIMIZED SOA ACCESS (Phase 4) ====================

  /**
   * Get raw SoA arrays for agents - zero allocation iteration
   * @returns {Object} { ids, names, displays, ... }
   */
  getAgentsSoA() {
    return { ...this.store.agents };
  }

  /**
   * Get raw SoA arrays for tasks - zero allocation iteration
   * @returns {Object} { ids, titles, statuses, ... }
   */
  getTasksSoA() {
    return { ...this.store.tasks };
  }

  /**
   * Get raw SoA arrays for terminals - zero allocation iteration
   * @returns {Object} { ids, types, statuses, ... }
   */
  getTerminalsSoA() {
    return { ...this.store.terminals };
  }

  /**
   * Get raw SoA arrays for floors - zero allocation iteration
   * @returns {Object} { ids, labels, runtimeStates, ... }
   */
  getFloorsSoA() {
    return { ...this.store.floors };
  }

  /**
   * Fast agent iteration with direct array access - avoids object creation
   * @param {Function} callback - (idx, agentData) => void
   * @param {Function} [filterFn] - (idx) => boolean
   */
  forEachAgent(callback, filterFn) {
    const store = this.store.agents;
    const len = store.ids.length;
    for (let i = 0; i < len; i++) {
      if (filterFn && !filterFn(i)) continue;
      callback(i, {
        id: store.ids[i],
        name: store.names[i],
        role: store.roles[i],
        floor: store.floors[i],
        provider: store.providers[i],
        model: store.models[i],
        cwd: store.cwds[i],
        cwdValid: store.cwdValids[i],
        display: store.displays[i],
        archived: store.archiveds[i],
        breaker: store.breakers[i],
        tokens: store.tokens[i],
        usd: store.usds[i],
        capUsdPerDay: store.capUsdPerDays[i],
        capUsdPerMonth: store.capUsdPerMonths[i],
        sessionUsd: store.sessionUsds[i],
        lastTool: store.lastTools[i],
        lastActiveSecAgo: store.lastActiveSecAgos[i],
        inboxBacklog: store.inboxBacklogs[i],
        onHold: store.onHolds[i],
        lastSeen: store.lastSeens[i],
        sessionId: store.sessionIds[i],
        sessionStatus: store.sessionStatuses[i],
        processId: store.processIds[i],
        heartbeatAgeSec: store.heartbeatAgeSecs[i],
        sessionFresh: store.sessionFreshes[i],
        currentTaskId: store.currentTaskIds[i],
        currentTaskTitle: store.currentTaskTitles[i],
        evidence: store.evidence[i]
      });
    }
  }

  /**
   * Fast task iteration with direct array access
   * @param {Function} callback
   * @param {Function} [filterFn]
   */
  forEachTask(callback, filterFn) {
    const store = this.store.tasks;
    const len = store.ids.length;
    for (let i = 0; i < len; i++) {
      if (filterFn && !filterFn(i)) continue;
      callback(i, {
        id: store.ids[i],
        title: store.titles[i],
        objective: store.objectives[i],
        status: store.statuses[i],
        risk: store.risks[i],
        assignedAgent: store.assignedAgents[i],
        claimedBy: store.claimedBys[i],
        claimedAt: store.claimedAts[i],
        floorId: store.floorIds[i],
        result: store.results[i]
      });
    }
  }

  /**
   * Batch set multiple agents - single tick, single validation pass
   * @param {Array<Object>} agents
   * @returns {number} count added/updated
   */
  setAgentsBatch(agents) {
    let count = 0;
    for (const agent of agents) {
      const missing = validateComponent('Agent', agent);
      if (missing.length) {
        console.warn(`Skipping agent ${agent.id}: missing ${missing.join(', ')}`);
        continue;
      }
      this.setAgent(agent);
      count++;
    }
    return count;
  }

  /**
   * Batch set multiple tasks
   * @param {Array<Object>} tasks
   * @returns {number} count added/updated
   */
  setTasksBatch(tasks) {
    let count = 0;
    for (const task of tasks) {
      const missing = validateComponent('Task', task);
      if (missing.length) {
        console.warn(`Skipping task ${task.id}: missing ${missing.join(', ')}`);
        continue;
      }
      this.setTask(task);
      count++;
    }
    return count;
  }

  /**
   * Get agents by floor (fast index lookup)
   * @param {string} floorId - e.g., 'floor:f3'
   * @returns {Array<Object>}
   */
  getAgentsByFloor(floorId) {
    const agents = [];
    this.forEachAgent(agent => agents.push(agent), 
      i => this.store.agents.floors[i] === floorId);
    return agents;
  }

  // ==================== UTILITY ====================

  /**
   * Clear all stores (for testing)
   */
  clear() {
    this.store = createWorld();
  }

  /**
   * Get debug info
   * @returns {Object}
   */
  debug() {
    return {
      version: this.store._version,
      agents: this.store.agents.ids.length,
      tasks: this.store.tasks.ids.length,
      terminals: this.store.terminals.ids.length,
      floors: this.store.floors.ids.length,
      hosts: this.store.hosts.ids.length,
      entities: this.store.entityIndex.size,
      changed: this.store._changed.size
    };
  }
}

module.exports = { createWorld, World };