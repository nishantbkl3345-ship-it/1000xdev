const cheerio = require('cheerio');
const browserManager = require('../utils/browser.manager');
const logger = require('../utils/logger');
const { BlockedPageError } = require('../utils/errors');

/**
 * BaseScraper — abstract class defining the contract + shared helpers.
 * All concrete scrapers (Amazon, Flipkart, Meesho) extend this.
 */
class BaseScraper {
  constructor(platformName) {
    this.platformName = platformName;
    if (new.target === BaseScraper) {
      throw new Error('BaseScraper is abstract and cannot be instantiated directly');
    }
  }

  /**
   * Main scrape method — fetches page, parses HTML, returns structured data.
   * @param {string} url
   * @returns {Promise<{product: Object, offers: Object, warnings: string[]}>}
   */
  async scrape(url) {
    const warnings = [];
    const t0 = Date.now();

    // 1. Fetch rendered HTML (subclass can customize browser options)
    const browserOptions = { ...this.getBrowserOptions(), platform: this.platformName };
    const html = await browserManager.getPage(url, browserOptions);

    // 2. Parse with Cheerio
    logger.info(`[${this.platformName}] Parsing started`);
    const $ = cheerio.load(html);

    // DEBUG: dump raw HTML for inspection
    if (this.platformName === 'FLIPKART') {
      try { require('fs').writeFileSync('/tmp/flipkart_debug.html', html); logger.info('[DEBUG] HTML dumped to /tmp/flipkart_debug.html'); } catch {}
    }

    // 3. Check for blocked page at extraction level
    //    (browser.manager already checks, but some blocks only show in body text)
    this._checkBlocked($, url);

    // 4. Extract product data
    const product = this.extractProduct($, warnings);

    // 5. Extract offers
    const offers = this.extractOffers($, warnings);

    // 6. Extract variants (optional — subclass may or may not implement)
    let variants = {};
    try {
      variants = this.extractVariants($, warnings);
    } catch {
      // variants are optional — never fail the scrape
    }

    const totalMs = Date.now() - t0;
    logger.info(`[${this.platformName}] [SUCCESS] Scrape completed in ${totalMs}ms`, {
      fieldsExtracted: Object.keys(product).filter((k) => product[k] !== null).length,
      offerCategories: Object.keys(offers).filter((k) => offers[k].length > 0).length,
      variantGroups: Object.keys(variants).length,
      warnings: warnings.length,
    });

    return { product, offers, variants, warnings };
  }

  /**
   * Override in subclass to provide custom browser options (e.g. waitForSelector).
   */
  getBrowserOptions() {
    return {};
  }

  /**
   * Check the loaded DOM for blocked-page signals.
   * Throws BlockedPageError so retry logic kicks in.
   */
  _checkBlocked($, url) {
    const title = $('title').text().trim().toLowerCase();
    const bodySnippet = $('body').text().trim().substring(0, 800).toLowerCase();

    const blockedSignals = [
      'access denied', 'robot check', 'enter the characters',
      'temporarily blocked', 'verify you are human',
      'unusual traffic', 'checking your browser',
      'validatecaptcha', 'opfcaptcha',
    ];

    // If page has product-like content (₹ price), skip block detection
    if (/₹[\d,]+/.test(bodySnippet)) return;

    for (const signal of blockedSignals) {
      if (title.includes(signal) || bodySnippet.includes(signal)) {
        logger.error(`[${this.platformName}] [BLOCKED] Blocked page detected: "${signal}"`);
        throw new BlockedPageError(url, { platform: this.platformName, signal });
      }
    }

    // Flipkart E002 — product unavailable / delisted
    if (/something went wrong.*e002/i.test(bodySnippet)) {
      const { AppError } = require('../utils/errors');
      throw new AppError('Product not available or delisted on Flipkart (E002)', 404);
    }
  }

  /**
   * Safe text extraction — returns trimmed text or null.
   * Pushes a warning if the field is expected but missing.
   */
  safeText($, selector, fieldName, warnings) {
    try {
      const text = $(selector).first().text().trim();
      if (!text) {
        warnings.push(`${fieldName} extraction returned empty`);
        return null;
      }
      return text;
    } catch {
      warnings.push(`${fieldName} extraction failed`);
      return null;
    }
  }

  /**
   * Safe attribute extraction — returns attribute value or null.
   */
  safeAttr($, selector, attr, fieldName, warnings) {
    try {
      const value = $(selector).first().attr(attr);
      if (!value) {
        warnings.push(`${fieldName} extraction returned empty`);
        return null;
      }
      return value.trim();
    } catch {
      warnings.push(`${fieldName} extraction failed`);
      return null;
    }
  }

  /**
   * Extract multiple text items from a selector.
   */
  safeTextAll($, selector) {
    const items = [];
    $(selector).each((_, el) => {
      const text = $(el).text().trim();
      if (text) items.push(text);
    });
    return items;
  }

  /**
   * Extract multiple attribute values from a selector.
   */
  safeAttrAll($, selector, attr) {
    const items = [];
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (value) items.push(value.trim());
    });
    return items;
  }

  /**
   * Parse a price string like "₹1,299" or "1,299.00" into a number.
   */
  parsePrice(priceStr) {
    if (!priceStr) return null;
    const cleaned = priceStr.replace(/[₹,\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  /**
   * Create the default offers structure.
   */
  emptyOffers() {
    return {
      bankOffers: [],
      emiOffers: [],
      coupons: [],
      exchangeOffers: [],
      deliveryOffers: [],
      otherOffers: [],
    };
  }

  // Abstract methods — must be overridden
  extractProduct($, warnings) {
    throw new Error(`${this.platformName}: extractProduct() not implemented`);
  }

  extractOffers($, warnings) {
    throw new Error(`${this.platformName}: extractOffers() not implemented`);
  }

  /**
   * Optional — override in subclass to extract product variants.
   * Returns an object like { color: [...], size: [...] } or empty {}.
   */
  extractVariants($, warnings) {
    return {};
  }
}

module.exports = BaseScraper;
