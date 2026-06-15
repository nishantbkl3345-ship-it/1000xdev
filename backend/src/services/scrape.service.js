const platformResolver = require('./platform.resolver');
const scraperRegistry = require('../scrapers/scraper.registry');
const logger = require('../utils/logger');

/**
 * ScrapeService — orchestrator.
 * Resolves platform → picks scraper → executes → returns data.
 */
class ScrapeService {
  /**
   * Scrape a product URL and return structured data.
   * @param {string} url
   * @returns {Promise<{platform: string, url: string, product: Object, offers: Object, warnings: string[]}>}
   */
  async scrape(url) {
    const startTime = Date.now();

    // 1. Resolve platform
    const platform = platformResolver.resolve(url);

    // 2. Get the correct scraper
    const scraper = scraperRegistry.get(platform);
    logger.info(`Using ${scraper.constructor.name} for scraping`);

    // 3. Execute scrape
    const result = await scraper.scrape(url);

    const durationMs = Date.now() - startTime;
    logger.info(`Scrape completed in ${durationMs}ms`, {
      platform,
      warnings: result.warnings.length,
    });

    return {
      platform,
      url,
      product: result.product,
      offers: result.offers,
      variants: result.variants,
      warnings: result.warnings,
      durationMs,
    };
  }
}

module.exports = new ScrapeService();
