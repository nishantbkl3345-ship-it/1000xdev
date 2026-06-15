const { Platform } = require('../config/platforms');
const AmazonScraper = require('./amazon.scraper');
const FlipkartScraper = require('./flipkart.scraper');
const MeeshoScraper = require('./meesho.scraper');

/**
 * ScraperRegistry — Strategy Pattern factory.
 * Maps Platform enum → concrete BaseScraper instance.
 */
const registry = new Map([
  [Platform.AMAZON, new AmazonScraper()],
  [Platform.FLIPKART, new FlipkartScraper()],
  [Platform.MEESHO, new MeeshoScraper()],
]);

module.exports = {
  /**
   * @param {string} platform — Platform enum value
   * @returns {import('./base.scraper')} scraper instance
   */
  get(platform) {
    const scraper = registry.get(platform);
    if (!scraper) {
      throw new Error(`No scraper registered for platform: ${platform}`);
    }
    return scraper;
  },
};
