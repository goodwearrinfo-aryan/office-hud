'use strict';
// Stateful layer on top of the pure analyzers: it remembers what it has already
// reported, so a persistent condition produces one alert (not one per tick),
// tracks first/last seen, keeps a bounded history, and supports acknowledgement.

const { analyze, summarize, RANK } = require('./analyzers');

const HISTORY_LIMIT = 200;

class AlertEngine {
  /**
   * @param {{read: () => object, intervalMs?: number, config?: object, onChange?: (alerts: any[]) => void}} options
   */
  constructor(options) {
    // The provider is `read`, not `snapshot`: a `snapshot` field would shadow
    // the snapshot() method below.
    this.read = options.read;
    this.intervalMs = options.intervalMs || 30000;
    this.config = options.config || {};
    this.onChange = options.onChange || null;
    this.active = new Map();   // fingerprint -> alert
    this.acked = new Set();    // fingerprints the operator has silenced
    this.history = [];         // resolved alerts, newest first
    this.timer = null;
    this.lastEvaluatedAt = null;
    this.runs = 0;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
    this.timer.unref?.();
    this.evaluate();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Recompute and fold the result into the active set. */
  evaluate(now = Date.now()) {
    let findings;
    try {
      findings = analyze(this.read(), { config: this.config, now });
    } catch (error) {
      findings = [{
        analyzer: 'engine',
        severity: 'warn',
        fingerprint: 'engine:failure',
        title: 'Alert engine could not read the hive',
        detail: error.message,
        at: now,
      }];
    }

    this.runs += 1;
    this.lastEvaluatedAt = now;
    const seen = new Set();

    for (const item of findings) {
      seen.add(item.fingerprint);
      const existing = this.active.get(item.fingerprint);
      if (existing) {
        // Keep firstSeen and any operator decision; refresh the live detail.
        existing.severity = item.severity;
        existing.title = item.title;
        existing.detail = item.detail;
        existing.metric = item.metric;
        existing.value = item.value;
        existing.lastSeen = now;
      } else {
        const wasAcked = this.acked.has(item.fingerprint);
        this.active.set(item.fingerprint, {
          ...item,
          firstSeen: now,
          lastSeen: now,
          acknowledged: wasAcked,
          acknowledgedAt: wasAcked ? now : null,
        });
      }
    }

    for (const [fingerprint, alert] of [...this.active]) {
      if (seen.has(fingerprint)) continue;
      // Condition cleared: retire it, and drop the ack so a recurrence alerts again.
      this.active.delete(fingerprint);
      this.acked.delete(fingerprint);
      this.history.unshift({ ...alert, resolvedAt: now, durationMs: now - alert.firstSeen });
    }
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;

    const list = this.snapshotList();
    this.onChange?.(list);
    return list;
  }

  snapshotList() {
    return [...this.active.values()]
      .sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.lastSeen - a.lastSeen)
      .map((alert) => ({ ...alert }));
  }

  snapshot() {
    const alerts = this.snapshotList();
    return {
      alerts,
      counts: summarize(alerts),
      unacknowledged: alerts.filter((alert) => !alert.acknowledged).length,
      history: this.history.slice(0, 25),
      lastEvaluatedAt: this.lastEvaluatedAt,
      intervalMs: this.intervalMs,
      runs: this.runs,
    };
  }

  ack(fingerprint) {
    const alert = this.active.get(fingerprint);
    if (!alert) return false;
    this.acked.add(fingerprint);
    alert.acknowledged = true;
    alert.acknowledgedAt = Date.now();
    return true;
  }

  ackAll() {
    let count = 0;
    for (const fingerprint of this.active.keys()) {
      if (this.ack(fingerprint)) count += 1;
    }
    return count;
  }

  unack(fingerprint) {
    this.acked.delete(fingerprint);
    const alert = this.active.get(fingerprint);
    if (!alert) return false;
    alert.acknowledged = false;
    alert.acknowledgedAt = null;
    return true;
  }
}

module.exports = { AlertEngine, HISTORY_LIMIT };
