const dotenv = require('dotenv');
dotenv.config();

const { SCRAPE_TIMEOUT, MAX_RETRIES, BACKOFF_BASE } = require('./constants');

/**
 * Centralized configuration — reads .env and auto-detects PROXY_ keys.
 */

const proxies = Object.keys(process.env)
  .filter((key) => /^PROXY_\d+$/.test(key))
  .sort()
  .map((key) => process.env[key])
  .filter(Boolean);

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  proxies,
  scrapeTimeout: parseInt(process.env.SCRAPE_TIMEOUT, 10) || SCRAPE_TIMEOUT,
  maxRetries: parseInt(process.env.MAX_RETRIES, 10) || MAX_RETRIES,
  backoffBase: parseInt(process.env.BACKOFF_BASE, 10) || BACKOFF_BASE,
};
