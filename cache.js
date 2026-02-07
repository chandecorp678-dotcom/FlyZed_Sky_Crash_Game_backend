'use strict';

/**
 * Simple in-memory TTL cache with automatic pruning.
 * Not distributed — fine for single-process deployments or short-term caching.
 *
 * API:
 *  - get(key) -> value|null
 *  - set(key, value, ttlMs)
 *  - del(key)
 *  - clear()
 *
 * Safe to require from multiple modules.
 */

const DEFAULT_PRUNE_INTERVAL_MS = Number(process.env.CACHE_PRUNE_INTERVAL_MS || 60_000); // 60s
const DEFAULT_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 5000);

class TTLCache {
  constructor(opts = {}) {
    this.map = new Map();
    this.maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
    this.pruneIntervalMs = opts.pruneIntervalMs || DEFAULT_PRUNE_INTERVAL_MS;
    this._startPrune();
  }

  _startPrune() {
    if (this.pruneTimer) return;
    try {
      this.pruneTimer = setInterval(() => this.prune(), this.pruneIntervalMs);
      if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
    } catch (e) {
      // ignore
    }
  }

  _now() {
    return Date.now();
  }

  get(key) {
    try {
      const rec = this.map.get(key);
      if (!rec) return null;
      if (rec.expiresAt && rec.expiresAt <= this._now()) {
        this.map.delete(key);
        return null;
      }
      return rec.value;
    } catch (e) {
      return null;
    }
  }

  set(key, value, ttlMs = 15000) {
    try {
      const expiresAt = ttlMs ? (this._now() + Number(ttlMs)) : null;
      this.map.set(key, { value, expiresAt, createdAt: this._now() });
      // enforce maxEntries eviction (remove oldest)
      if (this.map.size > this.maxEntries) {
        const firstKey = this.map.keys().next().value;
        if (firstKey) this.map.delete(firstKey);
      }
    } catch (e) {
      // ignore
    }
  }

  del(key) {
    try {
      this.map.delete(key);
    } catch (e) {}
  }

  clear() {
    try {
      this.map.clear();
    } catch (e) {}
  }

  prune() {
    try {
      const now = this._now();
      for (const [k, rec] of this.map) {
        if (rec.expiresAt && rec.expiresAt <= now) this.map.delete(k);
      }
      // If still over capacity, drop oldest entries
      while (this.map.size > this.maxEntries) {
        const firstKey = this.map.keys().next().value;
        if (!firstKey) break;
        this.map.delete(firstKey);
      }
    } catch (e) {
      // ignore
    }
  }
}

const cache = new TTLCache({
  maxEntries: Number(process.env.CACHE_MAX_ENTRIES || DEFAULT_MAX_ENTRIES),
  pruneIntervalMs: Number(process.env.CACHE_PRUNE_INTERVAL_MS || DEFAULT_PRUNE_INTERVAL_MS)
});

module.exports = cache;
