// Canonical floor route. Restored verbatim by floor_route_guard.py.
//
// The operator rule is that floors are never deleted. This route was removed
// three times in one day while hive/lib/floor_health.py kept computing every
// floor correctly the whole time: the data was never the problem, the route was.
//
// The derivation deliberately does NOT live here. It lives in the tracked
// module server/floor_health.js, which exists for exactly this reason:
// server/index.js is large and concurrently edited, and an inline version of
// this route was silently lost three times. Restoring this file therefore
// restores a thin call to durable, tested code rather than a second copy of
// the logic that can drift from it.
//
// HIVE is passed explicitly: the module's default resolves to
// ~/openalice-fleet/hive, which is not this deployment's tree. Without the
// override every floor correctly reports UNKNOWN ("script is missing") - honest,
// but useless. That binding bug was already fixed once in 91e12e1; the override
// is what keeps it fixed.
const { getFloorHealth } = require('./floor_health');

app.get('/api/floors', (_req, res) => {
  const result = getFloorHealth(HIVE);
  if (!result || !Array.isArray(result.floors) || result.floors.length === 0) {
    // A short or empty floor list is indistinguishable from a deleted floor,
    // so it is an error rather than an empty success.
    return sendError(res, 503, 'FLOOR_HEALTH_EMPTY',
      'floor_health returned no floors; floors are never removed');
  }
  res.json(Object.assign({}, result, {
    policy: 'floors are permanent; growth is additive only; never delete',
  }));
});
