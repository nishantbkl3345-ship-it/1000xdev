/**
 * Application constants — single source of truth for magic numbers.
 */
module.exports = {
  SCRAPE_TIMEOUT: 30000,        // 30 seconds max per page load
  MAX_RETRIES: 3,               // retry up to 3 times
  BACKOFF_BASE: 1000,           // base delay: 1s, 2s, 4s
  PROXY_COOLDOWN: 60000,        // 60 seconds cooldown on failed proxy
  NAVIGATION_WAIT: 'domcontentloaded', // Playwright wait condition
};
