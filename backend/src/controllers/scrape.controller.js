const scrapeService = require('../services/scrape.service');
const { successResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * ScrapeController — thin layer. Calls service, formats response.
 */
class ScrapeController {
  async handle(req, res, next) {
    try {
      const { url } = req.body;
      logger.info('Scrape request received', { url });

      const result = await scrapeService.scrape(url);

      return res.status(200).json(
        successResponse(
          {
            platform: result.platform,
            url: result.url,
            product: result.product,
            offers: result.offers,
            variants: result.variants,
          },
          result.warnings,
          { durationMs: result.durationMs }
        )
      );
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new ScrapeController();
