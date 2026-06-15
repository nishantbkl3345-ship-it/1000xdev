const config = require('../config');
const logger = require('./logger');

/**
 * ProxyManager — weighted random selection with scoring, escalating cooldowns,
 * and soft load-balancing.
 *
 * All 5 proxies are shared across every platform (Amazon, Flipkart, Meesho).
 * Weighted scoring ensures healthy proxies are preferred automatically.
 */
class ProxyManager {
  constructor() {
    this.proxies = config.proxies;

    /**
     * Per-proxy stats.
     * @type {Map<string, {successCount:number, failureCount:number, blockedCount:number, totalResponseTime:number, lastUsedAt:number, cooldownUntil:number, consecutiveFailures:number}>}
     */
    this.stats = new Map();

    // Initialize stats for each proxy
    for (const proxy of this.proxies) {
      this.stats.set(proxy, {
        successCount: 0,
        failureCount: 0,
        blockedCount: 0,
        totalResponseTime: 0,
        lastUsedAt: 0,
        cooldownUntil: 0,
        consecutiveFailures: 0,
      });
    }

    if (this.proxies.length > 0) {
      logger.info(`ProxyManager initialized with ${this.proxies.length} proxies (weighted scoring, shared pool)`);
    } else {
      logger.info('ProxyManager: no proxies configured, using direct connection');
    }
  }

  /**
   * Get a proxy via weighted random selection from the shared pool.
   *
   * @param {string} [platform] — for logging only; all platforms share the same pool.
   * @returns {string|null}
   */
  getProxy(platform) {
    if (this.proxies.length === 0) {
      logger.warn('No proxies configured');
      return null;
    }

    const now = Date.now();

    // Partition into available (not cooling down) and cooling-down
    const available = this.proxies.filter((p) => {
      const s = this.stats.get(p);
      return now >= s.cooldownUntil;
    });

    if (available.length === 0) {
      logger.error(`All ${this.proxies.length} proxies are in cooldown (platform: ${platform || 'unknown'})`);
      return null;
    }

    return this._weightedSelect(available, now);
  }

  /**
   * Weighted random selection from a pool of available proxies.
   */
  _weightedSelect(available, now) {
    // Calculate weight for each available proxy
    const weights = available.map((p) => this._calculateWeight(p, now));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    // Weighted random pick
    let rand = Math.random() * totalWeight;
    let selected = available[0];
    for (let i = 0; i < available.length; i++) {
      rand -= weights[i];
      if (rand <= 0) {
        selected = available[i];
        break;
      }
    }

    // Update lastUsedAt
    const s = this.stats.get(selected);
    s.lastUsedAt = now;

    logger.info('[PROXY] Proxy selected', {
      proxy: this._mask(selected),
      score: this._calculateWeight(selected, now).toFixed(2),
      successRate: this._successRate(s),
      avgResponseTime: this._avgResponseTime(s),
    });

    return selected;
  }

  /**
   * Mark a proxy as having succeeded.
   * @param {string} proxy
   * @param {number} responseTimeMs
   */
  markSuccess(proxy, responseTimeMs = 0) {
    if (!proxy) return;
    const s = this.stats.get(proxy);
    if (!s) return;
    s.successCount++;
    s.totalResponseTime += responseTimeMs;
    s.consecutiveFailures = 0; // reset streak

    logger.info('[PROXY] Proxy succeeded', {
      proxy: this._mask(proxy),
      responseTime: responseTimeMs,
      successRate: this._successRate(s),
    });
  }

  /**
   * Mark a proxy as temporarily failed — escalating cooldown.
   * @param {string} proxy
   */
  markFailed(proxy) {
    if (!proxy) return;
    const s = this.stats.get(proxy);
    if (!s) return;
    s.failureCount++;
    s.consecutiveFailures++;

    // Escalating cooldown: 60s → 120s → 300s
    const cooldowns = [60000, 120000, 300000];
    const idx = Math.min(s.consecutiveFailures - 1, cooldowns.length - 1);
    const cooldownMs = cooldowns[idx];
    s.cooldownUntil = Date.now() + cooldownMs;

    logger.error('[PROXY] Proxy failed', {
      proxy: this._mask(proxy),
      consecutiveFailures: s.consecutiveFailures,
      cooldownSec: cooldownMs / 1000,
    });
  }

  /**
   * Mark a proxy as blocked (much heavier penalty than a normal failure).
   * Anti-bot systems like Akamai block by IP for extended periods,
   * so retrying a blocked proxy quickly is futile and wastes time.
   * @param {string} proxy
   */
  markBlocked(proxy) {
    if (!proxy) return;
    const s = this.stats.get(proxy);
    if (!s) return;
    s.blockedCount++;
    s.failureCount++;
    s.consecutiveFailures += 3; // triple-increment — aggressive penalty

    // Blocked pages get moderate cooldown: 2min → 3min → 5min
    // (shorter than before — Meesho's 403 is often temporary)
    const cooldowns = [120000, 180000, 300000];
    const idx = Math.min(s.consecutiveFailures - 1, cooldowns.length - 1);
    const cooldownMs = cooldowns[idx];
    s.cooldownUntil = Date.now() + cooldownMs;

    logger.error('[PROXY] Proxy blocked by anti-bot', {
      proxy: this._mask(proxy),
      blockedCount: s.blockedCount,
      cooldownSec: cooldownMs / 1000,
    });
  }

  // ─── Private ───────────────────────────────────────────────────

  /**
   * Calculate weight for weighted random selection.
   * Higher weight = more likely to be selected.
   */
  _calculateWeight(proxy, now) {
    const s = this.stats.get(proxy);
    const total = s.successCount + s.failureCount;

    // Base weight
    let weight = 100;

    // Factor 1: Success rate (0–1) — higher is better
    if (total > 0) {
      const successRate = s.successCount / total;
      weight *= (0.3 + 0.7 * successRate); // range: 30–100% of base
    }

    // Factor 2: Blocked penalty — each block heavily reduces weight
    if (s.blockedCount > 0) {
      weight *= Math.max(0.05, 1 - s.blockedCount * 0.3);
    }

    // Factor 3: Average response time — prefer faster proxies
    if (s.successCount > 0) {
      const avgMs = s.totalResponseTime / s.successCount;
      if (avgMs < 5000) weight *= 1.2;       // fast bonus
      else if (avgMs < 10000) weight *= 1.0;  // neutral
      else if (avgMs < 20000) weight *= 0.7;  // slow penalty
      else weight *= 0.4;                      // very slow
    }

    // Factor 4: Soft load-balancing — recently used = temporary reduction
    if (s.lastUsedAt > 0) {
      const secondsSinceUse = (now - s.lastUsedAt) / 1000;
      if (secondsSinceUse < 10) weight *= 0.5;       // used < 10s ago
      else if (secondsSinceUse < 30) weight *= 0.75;  // used < 30s ago
    }

    // Never return zero — even bad proxies get a small chance
    return Math.max(weight, 1);
  }

  _successRate(s) {
    const total = s.successCount + s.failureCount;
    return total > 0 ? `${((s.successCount / total) * 100).toFixed(0)}%` : 'N/A';
  }

  _avgResponseTime(s) {
    return s.successCount > 0
      ? `${Math.round(s.totalResponseTime / s.successCount)}ms`
      : 'N/A';
  }

  _mask(proxy) {
    return proxy ? proxy.replace(/\/\/.*@/, '//<credentials>@') : 'direct';
  }
}

// Singleton
module.exports = new ProxyManager();
