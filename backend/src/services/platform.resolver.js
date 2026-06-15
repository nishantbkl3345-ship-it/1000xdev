const { HOSTNAME_MAP } = require('../config/platforms');
const { UnsupportedPlatformError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * PlatformResolver — extracts hostname from URL and maps to Platform enum.
 */
class PlatformResolver {
  /**
   * Resolve a URL to its platform.
   * @param {string} url — full product URL
   * @returns {string} Platform enum value
   * @throws {UnsupportedPlatformError}
   */
  resolve(url) {
    const { hostname } = new URL(url);
    const platform = HOSTNAME_MAP.get(hostname);

    if (!platform) {
      logger.warn(`Unsupported platform for hostname: ${hostname}`);
      throw new UnsupportedPlatformError(hostname);
    }

    logger.info(`Platform resolved: ${platform}`, { hostname });
    return platform;
  }
}

module.exports = new PlatformResolver();
