#!/usr/bin/env python3
"""Point the legacy REST routes at the resource table.

The socket pushes a resource while panels may still poll its twin, so the two
must not drift. This rewrites each legacy handler to `buildSnapshot(<name>)`,
leaving one implementation of every payload.
"""
import sys

PATH = '/Users/a/trading/oh-live/office-hud/server/index.js'

PAIRS = [
    ("""app.get('/api/summary', (_req, res) => {
  res.json({ ...hiveStatus(), fleet: getFleet(), godId: getRegistry().godId, agents: mergedAgents() });
});""",
     """app.get('/api/summary', (_req, res) => {
  res.json(buildSnapshot('summary'));
});""", 'summary'),

    ("""app.get('/api/agents', (_req, res) => {
  res.json({ agents: mergedAgents() });
});""",
     """app.get('/api/agents', (_req, res) => {
  res.json(buildSnapshot('agents'));
});""", 'agents'),

    ("""app.get('/api/queue', (_req, res) => {
  res.json(getQueueSummary());
});""",
     """app.get('/api/queue', (_req, res) => {
  res.json(buildSnapshot('queue'));
});""", 'queue'),

    ("""app.get('/api/projects', (_req, res) => {
  res.json(getProjects());
});""",
     """app.get('/api/projects', (_req, res) => {
  res.json(buildSnapshot('projects'));
});""", 'projects'),

    ("""app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: sessionRows() });
});""",
     """app.get('/api/sessions', (_req, res) => {
  res.json(buildSnapshot('sessions'));
});""", 'sessions'),

    ("""app.get('/api/processes', (_req, res) => {
  res.json(getProcesses());
});""",
     """app.get('/api/processes', (_req, res) => {
  res.json(buildSnapshot('processes'));
});""", 'processes'),

    ("""app.get('/api/verify', (_req, res) => {
  res.json(getVerifyState());
});""",
     """app.get('/api/verify', (_req, res) => {
  res.json(buildSnapshot('verify'));
});""", 'verify'),

    ("""app.get('/api/office-manager', (_req, res) => {
  res.json(getOfficeManagerStatus());
});""",
     """app.get('/api/office-manager', (_req, res) => {
  res.json(buildSnapshot('officeManager'));
});""", 'officeManager'),

    ("""app.get('/api/services/health', async (_req, res) => {
  res.json(await getServiceHealth());
});""",
     """app.get('/api/services/health', async (_req, res) => {
  res.json(await buildSnapshotAsync('services'));
});""", 'services'),

    ("""app.get('/api/harness/health', async (_req, res) => {
  res.json(await getHarnessHealth());
});""",
     """app.get('/api/harness/health', async (_req, res) => {
  res.json(await buildSnapshotAsync('harness'));
});""", 'harness'),

    ("""app.get('/api/llm/providers', (_req, res) => {
  try {
    const client = getLLMClient();
    res.json({ providers: client.getAllProviders(), health: client.getProviderHealth() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});""",
     """app.get('/api/llm/providers', (_req, res) => {
  res.json(buildSnapshot('providers'));
});""", 'providers'),

    ("""app.get('/api/llm/costs', (_req, res) => {
  const { getAllCosts, getTotalCosts, getAgentCosts } = require(path.join(HIVE, 'lib', 'llm', 'cost'));
  const agents = mergedAgents();
  const costs = {};
  for (const a of agents) {
    costs[a.id] = getAgentCosts(a.id);
  }
  res.json({ agents: costs, total: getTotalCosts() });
});""",
     """app.get('/api/llm/costs', (_req, res) => {
  res.json(buildSnapshot('costs'));
});""", 'costs'),

    ("""app.get('/api/llm/circuit-breakers', (_req, res) => {
  const { getAllBreakers } = require(path.join(HIVE, 'lib', 'llm', 'circuitBreaker'));
  res.json({ breakers: getAllBreakers() });
});""",
     """app.get('/api/llm/circuit-breakers', (_req, res) => {
  res.json(buildSnapshot('breakers'));
});""", 'breakers'),

    # /api/polymarket already delegates (its producer was extracted separately),
    # so it is deliberately absent from this list.

    ("""app.get('/api/knowledge/graphify/communities', (_req, res) => {
  res.json(getGraphifyCommunities());
});""",
     """app.get('/api/knowledge/graphify/communities', (_req, res) => {
  res.json(buildSnapshot('knowledge'));
});""", 'knowledge'),

    ("""app.get('/api/trading/backtests', (_req, res) => {
  res.json({ backtest: getBacktestResults(), walkforward: getWalkForwardResults() });
});""",
     """app.get('/api/trading/backtests', (_req, res) => {
  res.json(buildSnapshot('tradingBacktests'));
});""", 'tradingBacktests'),

    ("""app.get('/api/trading/strategies', (_req, res) => {
  res.json({ config: getTradingBotConfig(), strategies: getStrategies() });
});""",
     """app.get('/api/trading/strategies', (_req, res) => {
  res.json(buildSnapshot('tradingStrategies'));
});""", 'tradingStrategies'),

    ("""app.get('/api/trading/ops', (_req, res) => {
  res.json({ launchd: getFleetPlists(), adherence: getAdherenceLogs(), roster: getRoster() });
});""",
     """app.get('/api/trading/ops', (_req, res) => {
  res.json(buildSnapshot('tradingOps'));
});""", 'tradingOps'),

    ("""app.get('/api/jarvis/tasks', (req, res) => {
  res.json({ tasks: getJarvisTasks(req.query.limit) });
});""",
     """app.get('/api/jarvis/tasks', (_req, res) => {
  res.json(buildSnapshot('jarvisTasks'));
});""", 'jarvisTasks'),
]


def main():
    source = open(PATH, encoding='utf-8').read()
    problems = []
    for old, _new, label in PAIRS:
        count = source.count(old)
        if count != 1:
            problems.append(f'{label}: {count} matches')
    if problems:
        for line in problems:
            print('FAIL', line, file=sys.stderr)
        return 1
    for old, new, label in PAIRS:
        source = source.replace(old, new)
        print('ok', label)
    open(PATH, 'w', encoding='utf-8').write(source)
    print('WROTE', PATH)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
