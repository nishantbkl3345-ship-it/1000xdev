const BaseScraper = require('./base.scraper');

/**
 * MeeshoScraper — extracts product data and offers from Meesho pages.
 *
 * Meesho uses Akamai Bot Manager which aggressively blocks headless browsers.
 * This scraper relies on playwright-extra's stealth plugin (configured in
 * browser.manager.js) and requests extended challenge-wait time so the
 * Akamai JS challenge can auto-resolve before we extract HTML.
 *
 * Selector strategy: Meesho uses styled-components with hashed class names
 * that rotate on every deploy. All selectors avoid those hashes and rely on:
 *   - Semantic HTML (h1, h4, s, a[href])
 *   - Attribute patterns ([class*="..."] only for stable substrings)
 *   - Text-content / regex matching
 *   - Meesho CDN domain (meeshocdn.com) for images
 *   - __NEXT_DATA__ JSON blob (SSR fallback)
 *
 * PDP SCOPING: DOM-based extraction is scoped to the product detail area.
 * Nav, footer, recommendations, login popups are stripped before extraction.
 */
class MeeshoScraper extends BaseScraper {
  constructor() {
    super('MEESHO');
  }

  getBrowserOptions() {
    return {
      // Wait for product title or Meesho CDN images to appear
      waitForSelector: 'h1, img[src*="meeshocdn"]',
      // Shorter selector wait — Akamai challenge pages never have h1
      selectorTimeout: 5000,
      // Navigation timeout — give enough time for proxy + challenge
      timeout: 25000,
      // Give Akamai challenge up to 5 seconds
      challengeWaitMs: 5000,
      // Smart resource filter: core resources + meeshocdn images only
      blockResources: 'meesho',
      // 4 attempts — Meesho is the hardest to scrape, try more proxies
      maxRetries: 4,
      // Enable human-like page behavior (scroll + delay after load)
      humanSimulation: true,
      // Extra Sec-Fetch headers for Meesho Akamai
      extraHeaders: {
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
      },
    };
  }

  // ─── DOM Scoping ────────────────────────────────────────────

  /**
   * Strip non-PDP sections so DOM extraction is scoped to product area.
   */
  _scopeToPDP($) {
    $('header, nav, footer').remove();
    $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
    $('[class*="modal"], [class*="overlay"], [class*="popup"]').remove();
    $('[class*="cookie"], [class*="consent"]').remove();

    // Remove recommendation sections
    const recoRe = /similar\s+products|you\s+might|recently\s+viewed|customers\s+also|trending|more\s+from|explore\s+more|also\s+like|people\s+also/i;
    $('div, section').each((_, el) => {
      const $el = $(el);
      let headText = '';
      $el.children('h2, h3, h4, span, div').each((_, ch) => {
        const t = $(ch).text().trim();
        if (t.length < 80) headText += ' ' + t;
      });
      if (recoRe.test(headText) && $el.find('a[href*="/p/"]').length >= 3) {
        $el.remove();
      }
    });
  }

  /**
   * Get element's OWN text only (excluding children text).
   */
  _ownText($, el) {
    return $(el).clone().children().remove().end().text().trim();
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Search elements matching selector for one whose text matches a regex.
   * Returns matched text or null.
   */
  safeExtract($, selector, regex, fieldName, warnings) {
    let result = null;
    try {
      $(selector).each((_, el) => {
        const text = $(el).text().trim();
        if (regex.test(text)) {
          result = text;
          return false; // break
        }
      });
    } catch {
      // silent
    }
    if (!result && warnings) warnings.push(`${fieldName} extraction failed`);
    return result;
  }

  /**
   * Try to extract product data from Meesho's __NEXT_DATA__ JSON blob.
   * Meesho is a Next.js app and embeds full product JSON in the SSR payload.
   * Returns the product props object, or null if not found.
   */
  _extractNextData($) {
    try {
      const scriptEl = $('script#__NEXT_DATA__');
      if (!scriptEl.length) return null;

      const json = JSON.parse(scriptEl.html());
      const pageProps = json?.props?.pageProps;
      if (!pageProps) return null;

      return pageProps.productData || pageProps.productDetails || pageProps;
    } catch {
      return null;
    }
  }

  // ─── Product Extraction ─────────────────────────────────────

  extractProduct($, warnings) {
    // Blocked-page check is now handled by base.scraper._checkBlocked()
    // which throws BlockedPageError before extractProduct is called.

    // ── Strategy 1: Extract from __NEXT_DATA__ (most reliable) ──
    const nextData = this._extractNextData($);
    if (nextData) {
      const result = this._extractFromNextData(nextData, $, warnings);
      if (result && result.title) {
        return result;
      }
    }

    // ── Strategy 2: DOM extraction (fallback — scoped) ────────
    return this._extractFromDOM($, warnings);
  }

  /**
   * Extract product data from __NEXT_DATA__ JSON.
   */
  _extractFromNextData(data, $, warnings) {
    try {
      const title =
        data.name ||
        data.productName ||
        data.product_name ||
        data.title ||
        null;

      const price =
        data.price ||
        data.min_catalog_price ||
        data.variations?.[0]?.price ||
        data.catalog_price ||
        null;

      const mrp =
        data.mrp ||
        data.original_price ||
        data.supply_price ||
        data.variations?.[0]?.mrp ||
        null;

      const discountVal =
        data.discount ||
        data.discount_percentage ||
        null;
      const discount = discountVal ? `${discountVal}% off` : null;

      const rating =
        data.rating ||
        data.product_rating ||
        data.catalog_reviews_summary?.average_rating ||
        null;

      const reviewCount =
        data.review_count ||
        data.total_reviews ||
        data.catalog_reviews_summary?.review_count ||
        null;

      const seller =
        data.supplier?.name ||
        data.supplierName ||
        data.supplier_name ||
        null;

      // Images from __NEXT_DATA__
      let images = [];
      if (Array.isArray(data.images)) {
        images = data.images.map((img) =>
          typeof img === 'string' ? img : img.url || img.src || img.original || ''
        ).filter(Boolean);
      } else if (Array.isArray(data.product_images)) {
        images = data.product_images.map((img) =>
          typeof img === 'string' ? img : img.url || img.src || ''
        ).filter(Boolean);
      } else if (Array.isArray(data.catalogImages)) {
        images = data.catalogImages.map((img) =>
          typeof img === 'string' ? img : img.url || ''
        ).filter(Boolean);
      }

      if (images.length === 0) {
        images = this._extractImages($);
      }

      const availability =
        data.in_stock === false || data.is_out_of_stock === true
          ? 'Out of Stock'
          : 'In Stock';

      if (!title) warnings.push('title not found in __NEXT_DATA__');
      if (!price) warnings.push('price not found in __NEXT_DATA__');

      return {
        title,
        price: typeof price === 'number' ? price : this.parsePrice(String(price)),
        mrp: typeof mrp === 'number' ? mrp : this.parsePrice(String(mrp)),
        currency: 'INR',
        discount,
        rating: typeof rating === 'number' ? rating : rating ? parseFloat(rating) : null,
        reviewCount: typeof reviewCount === 'number' ? reviewCount : null,
        seller,
        availability,
        images,
      };
    } catch (err) {
      warnings.push('__NEXT_DATA__ parsing failed, falling back to DOM');
      return null;
    }
  }

  /**
   * DOM-based extraction — used when __NEXT_DATA__ is not available.
   * Scoped to PDP region to avoid contamination.
   */
  _extractFromDOM($, warnings) {
    // Scope DOM before extraction
    this._scopeToPDP($);

    // Find PDP region near the product title
    const $titleEl = $('h1').first();
    let $pdp = $('body');
    if ($titleEl.length) {
      let $r = $titleEl;
      for (let i = 0; i < 4; i++) {
        const $p = $r.parent();
        if (!$p.length || $p.is('body')) break;
        $r = $p;
      }
      $pdp = $r;
    }

    // === TITLE ===
    const title =
      this.safeText($, 'h1', 'title', []) ||
      this.safeText($, '[class*="ProductTitle"]', 'title', []) ||
      (() => {
        const pt = this.safeText($, 'title', 'title', []);
        if (pt) {
          const cleaned = pt.split(/\s*[|–-]\s*Meesho/i)[0].trim();
          return cleaned || null;
        }
        return null;
      })();

    if (!title) warnings.push('title extraction failed');

    // === PRICE (scoped to PDP region) ===
    const priceText =
      this.safeExtract($, 'h4, h3, h2', /^₹[\d,]+$/, 'price', []) ||
      this.safeText($, '[class*="PriceText"]', 'price', []) ||
      (() => {
        let found = null;
        $pdp.find('span, p, h4, h3').each((_, el) => {
          const t = $(el).text().trim();
          if (/^₹[\d,]+$/.test(t)) { found = t; return false; }
        });
        return found;
      })();

    if (!priceText) warnings.push('price extraction failed');

    // === MRP ===
    const mrpText =
      this.safeText($, 's:contains("₹")', 'mrp', []) ||
      this.safeText($, 'strike:contains("₹")', 'mrp', []) ||
      this.safeText($, 'del:contains("₹")', 'mrp', []) ||
      this.safeText($, '[class*="StrikeText"]', 'mrp', []);

    // === DISCOUNT ===
    const discount =
      this.safeExtract($, 'span, p, b', /^\d+%\s*off$/i, 'discount', []) ||
      this.safeText($, '[class*="DiscountPercent"]', 'discount', []) ||
      this.safeText($, '[class*="discount"]', 'discount', []);

    // === RATING (scoped) ===
    const ratingText =
      this.safeText($, '[class*="RatingCount"]', 'rating', []) ||
      (() => {
        let found = null;
        $pdp.find('span, div').each((_, el) => {
          const $el = $(el);
          if ($el.children().length > 0) return;
          const t = $el.text().trim();
          if (/^\d\.\d$/.test(t)) { found = t; return false; }
        });
        return found;
      })();
    const rating = ratingText ? parseFloat(ratingText) : null;

    // === REVIEW COUNT (scoped) ===
    let reviewCount = null;
    const reviewText = (() => {
      let found = null;
      $pdp.find('span, p, div').each((_, el) => {
        const t = $(el).text().trim();
        if (/[\d,]+\s*review/i.test(t) && t.length < 100) { found = t; return false; }
        if (/[\d,]+\s*rating/i.test(t) && t.length < 100) { found = t; return false; }
      });
      return found;
    })();
    if (reviewText) {
      const match = reviewText.match(/([\d,]+)/);
      if (match) reviewCount = parseInt(match[1].replace(/,/g, ''), 10);
    }

    // === SELLER ===
    const seller =
      this.safeText($, 'a[href*="/supplier/"]', 'seller', []) ||
      this.safeText($, 'a[href*="/supplier/"] span', 'seller', []) ||
      this.safeText($, '[class*="SupplierName"]', 'seller', []);

    // === AVAILABILITY (scoped — no body-wide scan) ===
    let availability = 'In Stock';
    const pdpText = $pdp.text();
    if (/sold\s*out/i.test(pdpText) || /out\s*of\s*stock/i.test(pdpText)) {
      availability = 'Out of Stock';
    }

    // === IMAGES (scoped — CDN-based) ===
    const images = this._extractImages($);
    if (images.length === 0) warnings.push('images extraction failed');

    return {
      title: title || null,
      price: this.parsePrice(priceText),
      mrp: this.parsePrice(mrpText),
      currency: 'INR',
      discount: discount || null,
      rating: isNaN(rating) ? null : rating,
      reviewCount: isNaN(reviewCount) ? null : reviewCount,
      seller: seller || null,
      availability,
      images,
    };
  }

  /**
   * Extract images from DOM — shared by both __NEXT_DATA__ and DOM strategies.
   * Uses CDN domain filtering to avoid picking up logos/icons.
   */
  _extractImages($) {
    const images = [];
    const seen = new Set();

    $('img[src*="meeshocdn"]').each((_, el) => {
      const src = $(el).attr('src');
      if (src && !seen.has(src)) { seen.add(src); images.push(src); }
    });

    if (images.length === 0) {
      $('img[src*="meesho"]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && !seen.has(src)) { seen.add(src); images.push(src); }
      });
    }

    if (images.length === 0) {
      $('img[data-src*="meesho"]').each((_, el) => {
        const src = $(el).attr('data-src');
        if (src && !seen.has(src)) { seen.add(src); images.push(src); }
      });
    }

    // Last resort — only large product images, skip icons/logos
    if (images.length === 0) {
      $('img[src]').each((_, el) => {
        const $el = $(el);
        const src = $el.attr('src');
        if (!src || !src.startsWith('http')) return;
        if (/logo|icon|sprite|favicon|badge/i.test(src)) return;
        // Skip tiny images (likely icons) — check width/height attrs
        const w = parseInt($el.attr('width') || '0', 10);
        const h = parseInt($el.attr('height') || '0', 10);
        if ((w > 0 && w < 50) || (h > 0 && h < 50)) return;
        if (!seen.has(src)) { seen.add(src); images.push(src); }
      });
    }

    return images;
  }

  // ─── Variants Extraction ────────────────────────────────────

  extractVariants($, warnings) {
    const variants = { selected: {}, available: {} };

    try {
      // Strategy 1: __NEXT_DATA__ contains variant/variation data
      const nextData = this._extractNextData($);
      if (nextData) {
        this._extractVariantsFromNextData(nextData, variants);
        if (Object.keys(variants.available).length > 0) return variants;
      }

      // Strategy 2: DOM-based — label-driven extraction
      this._extractVariantsFromDOM($, variants);
    } catch {
      warnings.push('variants extraction failed');
    }

    return variants;
  }

  /**
   * Extract variants from __NEXT_DATA__ JSON into unified shape.
   */
  _extractVariantsFromNextData(data, variants) {
    try {
      // Meesho __NEXT_DATA__ may contain:
      // data.variations (array of {name, values})
      // data.product_variations
      // data.groupedVariations
      const variations =
        data.variations ||
        data.product_variations ||
        data.groupedVariations ||
        [];

      if (Array.isArray(variations) && variations.length > 0) {
        for (const v of variations) {
          const dimName = (v.name || v.attribute_name || v.label || '').toLowerCase().replace(/\s+/g, '_');
          if (!dimName) continue;

          const values = v.values || v.options || v.items || [];
          if (!Array.isArray(values) || values.length === 0) continue;

          const seen = new Set();
          const optionNames = [];
          let selectedValue = null;

          for (const val of values) {
            const name = typeof val === 'string' ? val : val.name || val.value || val.label || '';
            if (!name || seen.has(name)) continue;
            seen.add(name);
            optionNames.push(name);
            if (val.selected || val.is_selected) selectedValue = name;
          }

          if (optionNames.length > 0) {
            variants.available[dimName] = optionNames;
            if (selectedValue) variants.selected[dimName] = selectedValue;
          }
        }
      }

      // Also check for catalog-level size/color groupings
      if (data.catalog_sizes && Array.isArray(data.catalog_sizes)) {
        const seen = new Set();
        const sizes = [];
        let selectedSize = null;
        for (const s of data.catalog_sizes) {
          const name = typeof s === 'string' ? s : s.name || s.value || '';
          if (!name || seen.has(name)) continue;
          seen.add(name);
          sizes.push(name);
          if (s.selected) selectedSize = name;
        }
        if (sizes.length > 0) {
          variants.available.size = sizes;
          if (selectedSize) variants.selected.size = selectedSize;
        }
      }
    } catch {
      // silent — variants are optional
    }
  }

  /**
   * DOM-based variant extraction — label-driven, own-text matching,
   * multi-level container walk.
   */
  _extractVariantsFromDOM($, variants) {
    const dimensions = [
      { key: 'size',    re: /^(?:select\s+)?size$/i },
      { key: 'color',   re: /^(?:select\s+)?colou?r$/i },
      { key: 'type',    re: /^(?:select\s+)?(?:type|variant|pack)$/i },
      { key: 'quantity', re: /^(?:select\s+)?(?:quantity|pack\s+of)$/i },
      { key: 'material', re: /^(?:select\s+)?material$/i },
    ];

    for (const dim of dimensions) {
      this._extractDimensionFromDOM($, dim.key, dim.re, variants);
    }
  }

  /**
   * Extract a single variant dimension from DOM.
   */
  _extractDimensionFromDOM($, key, labelRe, variants) {
    let found = false;

    $('h4, h3, h5, p, span, div, strong, b').each((_, labelEl) => {
      if (found) return false;

      const $label = $(labelEl);
      const ownText = this._ownText($, labelEl);

      if (!ownText || ownText.length > 30 || !labelRe.test(ownText)) return;

      // Detect selected value from adjacent text
      let selectedValue = null;
      const $labelParent = $label.parent();
      $labelParent.children().each((_, sib) => {
        if (sib === labelEl) return;
        const sibText = $(sib).text().trim();
        if (sibText && sibText.length < 40 && !labelRe.test(sibText)) {
          selectedValue = sibText;
          return false;
        }
      });

      // Walk up to find container with option elements
      let $container = $labelParent;

      for (let level = 0; level < 5; level++) {
        $container = $container.parent();
        if (!$container.length || $container.is('body')) break;

        const $options = $container.find('button, a[role="button"], [role="button"], li, a[href]');
        if ($options.length < 2) continue;

        const optionNames = [];
        const seenOpt = new Set();

        $options.each((_, optEl) => {
          const $opt = $(optEl);
          const optText = $opt.text().trim();
          if (!optText || optText.length > 50 || seenOpt.has(optText)) return;
          if (labelRe.test(optText)) return;
          if (/add to cart|buy now|wishlist|share|notify/i.test(optText)) return;

          seenOpt.add(optText);
          optionNames.push(optText);
        });

        if (optionNames.length >= 1) {
          variants.available[key] = optionNames;
          if (selectedValue) variants.selected[key] = selectedValue;
          found = true;
          break;
        }
      }

      if (!found && selectedValue) {
        variants.selected[key] = selectedValue;
        found = true;
      }

      if (found) return false;
    });
  }

  // ─── Offers Extraction ──────────────────────────────────────

  extractOffers($, warnings) {
    const offers = this.emptyOffers();
    const seen = new Set();

    // Junk filter — never include these in offers
    const junkRe = /log\s*in|sign\s*up|sign\s*in|my\s*account|my\s*orders|my\s*cart|my\s*wishlist|help|faq|customer\s*care|download\s*app|payments|sell\s*on|terms|privacy|policy|copyright|footer/i;

    const offerKeywords = /bank|card|cashback|emi|deliver|free|shipping|off on|coupon|offer|discount/i;

    try {
      // ── Strategy 1: class-based offer containers ──
      $('[class*="offer" i] span, [class*="offer" i] div, [class*="Offer"] span, [class*="Offer"] div').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!text || text.length < 10 || text.length > 400) return;
        if (!offerKeywords.test(text)) return;
        if (junkRe.test(text)) return;
        if (seen.has(text)) return;
        if ($(el).find('li').length >= 2) return; // parent container — skip
        seen.add(text);
        this._categorizeOffer(text, offers);
      });

      // ── Strategy 2: scoped delivery text ──
      const deliveryText =
        this.safeExtract($, '[class*="delivery" i] span, [class*="delivery" i] p, [class*="delivery" i] div',
          /free\s*delivery|delivery\s*by|estimated\s*delivery/i, 'delivery', []);

      if (deliveryText) {
        const cleaned = deliveryText.replace(/\s+/g, ' ').trim();
        if (cleaned.length > 5 && !seen.has(cleaned) && !junkRe.test(cleaned)) {
          seen.add(cleaned);
          offers.deliveryOffers.push({ description: cleaned, terms: null });
        }
      }

      // ── Strategy 3: scoped return policy ──
      const returnText =
        this.safeExtract($, '[class*="return" i] span, [class*="return" i] p, [class*="return" i] div',
          /return|refund|exchange.*day/i, 'return', []);

      if (returnText) {
        const cleaned = returnText.replace(/\s+/g, ' ').trim();
        if (cleaned.length > 10 && cleaned.length < 200 && !seen.has(cleaned) && !junkRe.test(cleaned)) {
          seen.add(cleaned);
          offers.otherOffers.push({ description: cleaned, terms: null });
        }
      }
    } catch {
      warnings.push('offers extraction partially failed');
    }

    return offers;
  }

  // ─── Private Helpers ────────────────────────────────────────

  _categorizeOffer(text, offers) {
    if (/bank\s*offer|credit\s*card|debit\s*card|cashback|instant\s*discount/i.test(text)) {
      offers.bankOffers.push({ description: text, terms: null });
    } else if (/no\s*cost\s*emi|emi\s*available|emi\s*start/i.test(text)) {
      offers.emiOffers.push({ description: text, terms: null });
    } else if (/exchange|trade.?in/i.test(text)) {
      offers.exchangeOffers.push({ description: text, terms: null });
    } else if (/coupon|apply.*off/i.test(text)) {
      offers.coupons.push({ description: text, code: null });
    } else if (/deliver|shipping|free.*delivery|dispatch/i.test(text)) {
      offers.deliveryOffers.push({ description: text, terms: null });
    } else {
      offers.otherOffers.push({ description: text, terms: null });
    }
  }

  _totalOffers(offers) {
    return Object.values(offers).reduce((sum, arr) => sum + arr.length, 0);
  }
}

module.exports = MeeshoScraper;
