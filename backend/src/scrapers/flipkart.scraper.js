const BaseScraper = require('./base.scraper');

/**
 * FlipkartScraper — extracts product data and offers from Flipkart pages.
 *
 * Selector strategy: avoids obfuscated class names that rotate on every deploy.
 * Uses semantic HTML, attribute patterns, text-content matching, and fallback chains.
 *
 * PDP SCOPING: Before any extraction, non-PDP sections (nav, footer,
 * recommendations, login popups, ads) are stripped so that every selector
 * operates only on the product detail area.
 */
class FlipkartScraper extends BaseScraper {
  constructor() {
    super('FLIPKART');
  }

  getBrowserOptions() {
    return {
      waitUntil: 'domcontentloaded',     // Faster than networkidle — content-ready wait handles React hydration
      waitForSelector: 'h1, [class*="wjcEIp"], [class*="VU-ZEz"], div[class*="DOjaWF"]',
      selectorTimeout: 10000,
      postNavDelay: 3000,                // Extra delay for React hydration
      timeout: 35000,
      maxRetries: 4,                     // More retries: 3 proxy attempts + 1 direct fallback
      waitForContentReady: true,
      blockResources: false,             // Don't block images/fonts — Flipkart detects this as bot
    };
  }

  // ─── DOM Scoping ────────────────────────────────────────────

  /**
   * Strip non-PDP sections so all extraction is scoped to the product area.
   */
  _scopeToPDP($) {
    // ONLY remove structural navigation elements — NOT content sections
    // Flipkart uses class names like 'popup', 'modal' in legitimate PDP elements,
    // so broad class-based removal destroys product data.
    $('header, nav, footer').remove();
    $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();

    // Cookie banners (safe — always non-product)
    $('[class*="cookie"], [class*="consent"]').remove();
  }

  // ─── Ad Removal ─────────────────────────────────────────────

  /**
   * Detect and REMOVE all sponsored/ad containers from the DOM before extraction.
   */
  _markAndRemoveAds($) {
    let count = 0;

    // Strategy 1: fm= tracking param containing "advertisement"
    $('a[href*="fm="]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      try {
        const url = new URL(href, 'https://www.flipkart.com');
        const fm = url.searchParams.get('fm');
        if (fm) {
          const decoded = Buffer.from(fm, 'base64').toString('utf-8');
          if (/advert/i.test(decoded)) { $el.remove(); count++; return; }
        }
      } catch {
        if (/fm=.*advert/i.test(href)) { $el.remove(); count++; return; }
      }
    });

    // Strategy 2: "AD" badge text
    $('div, span').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if ((text === 'AD' || text === 'Ad') && $el.children().length === 0) {
        const $adC = $el.closest('a[href]');
        if ($adC.length) { $adC.remove(); count++; }
        else {
          let $p = $el;
          for (let i = 0; i < 6; i++) {
            $p = $p.parent();
            if (!$p.length) break;
            if ($p.find('img').length > 0 && /₹[\d,]+/.test($p.text())) {
              $p.remove(); count++; break;
            }
          }
        }
      }
    });

    // Strategy 3: Tracking data attributes
    $('[data-tkid], [data-creative-id]').each((_, el) => {
      let $c = $(el);
      for (let i = 0; i < 5; i++) {
        $c = $c.parent();
        if (!$c.length) break;
        if ($c.find('img').length > 0 && /₹/.test($c.text())) {
          $c.remove(); count++; break;
        }
      }
    });

    // Strategy 4: Ad tracking URLs (be conservative — ssid/tkid appear in normal links)
    $('a[href*="clickTracker"], a[href*="ads.flipkart"]').each((_, el) => {
      $(el).remove(); count++;
    });

    return count;
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Get element's OWN text only (excluding children text).
   */
  _ownText($, el) {
    return $(el).clone().children().remove().end().text().trim();
  }

  /**
   * First non-empty text match for a selector.
   */
  _firstText($, selector) {
    let result = null;
    $(selector).each((_, el) => {
      const t = $(el).text().trim();
      if (t) { result = t; return false; }
    });
    return result;
  }

  /**
   * Find the PDP region element (container nearest to the product title).
   * All scoped fallbacks search within this region.
   */
  _getPDPRegion($) {
    // After _scopeToPDP() has already stripped nav, footer, recommendations,
    // login popups, and _markAndRemoveAds() has removed sponsored content,
    // the remaining DOM is clean. Use the full cleaned container as PDP region
    // so that price/MRP/discount nodes (which are siblings of the title's
    // distant ancestor) are always included.
    if ($('div#container').length) return $('div#container');
    return $('body');
  }

  // ─── Product Extraction ─────────────────────────────────────

  extractProduct($, warnings) {
    // === STEP 0: Detect Flipkart E002 error (product delisted/unavailable) ===
    const bodyText = $('body').text().trim().substring(0, 2000).toLowerCase();
    if (/something went wrong/.test(bodyText) && /e002/.test(bodyText)) {
      const { AppError } = require('../utils/errors');
      throw new AppError('Product not available or delisted on Flipkart (E002)', 404);
    }

    // === STEP 1: Clean DOM ===
    const adsRemoved = this._markAndRemoveAds($);
    if (adsRemoved > 0) warnings.push(`Removed ${adsRemoved} ad container(s)`);
    this._scopeToPDP($);

    const $pdp = this._getPDPRegion($);

    // === JSON-LD (most reliable source — never rotates) ===
    let ldJson = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const d = JSON.parse($(el).html());
        if (d['@type'] === 'Product' || d.name) ldJson = d;
      } catch {}
    });

    // === TITLE ===
    // JSON-LD name is always clean and reliable
    const title =
      ldJson?.name?.replace(/\s+/g, ' ').trim() ||
      // h1 — but skip noise h1s like "More about..."
      (() => {
        let best = null;
        $('h1').each((_, el) => {
          const t = $(el).text().trim().replace(/\s+/g, ' ');
          if (!t || t.length < 10) return;
          // Clean Flipkart title: strip "...more" and trailing "+" suffix
          if (/^more\s+about\s+/i.test(t)) {
            if (!best) best = t.replace(/^more\s+about\s+/i, '').replace(/\.\.\.(more)?\s*\+?$/i, '').replace(/\+$/, '').trim();
            return;
          }
          best = t.replace(/\.\.\.(more)?\s*\+?$/i, '').trim();
        });
        return best || null;
      })() ||
      this._firstText($, 'span[class*="VU-ZEz"]') ||
      this._firstText($, 'span[class*="K8x9NI"]') ||
      this._firstText($, '[class*="B_NuCI"]') ||
      (() => {
        const t = $('title').text().trim();
        return t ? t.split(/\s*[-|–]\s*(Buy|Flipkart)/i)[0].trim() || null : null;
      })();
    if (!title) warnings.push('title extraction failed');

    // === PRICE / MRP / DISCOUNT ===
    // Flipkart 2026: variant boxes and main price section have identical
    // structure ({↓X% + MRP(line-through) + ₹price}). Extract all three
    // from the same non-variant container to ensure consistency.
    const pricing = this._extractPricingInfo($, $pdp, ldJson);
    const priceText = pricing.price;
    const mrpText = pricing.mrp;
    const discount = pricing.discount;
    if (!priceText) warnings.push('price extraction failed');

    // === RATING (scoped to PDP region) ===
    const ratingText =
      this._firstText($, '[class*="XQDdHH"]') ||
      this._firstText($, '[class*="3LWZlK"]') ||
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

    // === REVIEW COUNT ===
    let reviewCount = null;
    let ratingCount = null;
    const reviewMeta =
      this._firstText($, 'span[class*="Wphh3N"] span span') ||
      this._firstText($, '[class*="2_R_DZ"] span') ||
      (() => {
        let found = null;
        $pdp.find('span, div').each((_, el) => {
          const t = $(el).text().trim();
          if (/[\d,]+\s*rating/i.test(t) && t.length < 100) { found = t; return false; }
        });
        return found;
      })();
    if (reviewMeta) {
      const rm = reviewMeta.match(/([\d,]+)\s*review/i);
      if (rm) reviewCount = parseInt(rm[1].replace(/,/g, ''), 10);
      const rr = reviewMeta.match(/([\d,]+)\s*rating/i);
      if (rr) ratingCount = parseInt(rr[1].replace(/,/g, ''), 10);
    }

    // === SELLER ===
    const seller =
      this.safeText($, '#sellerName span span', 'seller', []) ||
      this.safeText($, '#sellerName span', 'seller', []) ||
      this.safeText($, '#sellerName a', 'seller', []) ||
      this.safeText($, 'a[href*="/seller/"] span', 'seller', []);

    // === AVAILABILITY (scoped — no body-wide scan) ===
    let availability = 'In Stock';
    const pdpText = $pdp.text();
    if (/currently unavailable/i.test(pdpText) || /coming soon/i.test(pdpText)) {
      availability = 'Out of Stock';
    }

    // === IMAGES (scoped: only product gallery, not recommendations) ===
    const images = [];
    const seenImg = new Set();

    // Strategy 1: JSON-LD images (most reliable, never rotated)
    if (ldJson?.image) {
      const ldImgs = Array.isArray(ldJson.image) ? ldJson.image : [ldJson.image];
      for (const img of ldImgs) {
        const src = typeof img === 'string' ? img : img?.url;
        if (src && !seenImg.has(src)) { seenImg.add(src); images.push(src); }
      }
    }

    // Strategy 2: DOM gallery images
    if (images.length === 0) {
      const $imgRegion = $pdp.length ? $pdp : $('body');
      const collectImages = ($scope) => {
        $scope.find('img[src*="rukminim"]').each((_, el) => {
          let src = $(el).attr('src');
          if (!src) return;
          // Upscale thumbnails to full size
          src = src.replace(/\/\d+\/\d+\//g, '/416/416/').replace(/\._.*_\./, '.');
          if (!seenImg.has(src)) { seenImg.add(src); images.push(src); }
        });
        if (images.length === 0) {
          $scope.find('img[data-src*="rukminim"]').each((_, el) => {
            let src = $(el).attr('data-src');
            if (src && !seenImg.has(src)) { seenImg.add(src); images.push(src); }
          });
        }
      };
      collectImages($imgRegion);
      if (images.length === 0) collectImages($('body'));
    }
    if (images.length === 0) warnings.push('images extraction failed');

    // === DELIVERY ===
    const delivery = this._extractDelivery($);

    // === HIGHLIGHTS / SPECS ===
    const { highlights, specs } = this._extractHighlights($);

    console.log('[FLIPKART] PDP region size:', $pdp.html()?.length || 0);

    return {
      title: title || null,
      price: this.parsePrice(priceText),
      mrp: this.parsePrice(mrpText),
      currency: 'INR',
      discount: discount || null,
      rating: isNaN(rating) ? null : rating,
      reviewCount: isNaN(reviewCount) ? null : reviewCount,
      ratingCount: isNaN(ratingCount) ? null : ratingCount,
      seller: seller || null,
      availability,
      images,
      delivery,
      highlights,
      specs,
    };
  }

  /**
   * Extract price, MRP, and discount as a unified triplet from the same
   * DOM container to guarantee consistency across variant-switching.
   *
   * Flipkart 2026 layout places {↓X% + MRP(line-through) + ₹price}
   * groups in BOTH variant boxes AND the main price section. We walk up
   * from each line-through MRP element to find the containing group, tag
   * it as "variant" or "main", and return the main one.
   *
   * @returns {{ price: string|null, mrp: string|null, discount: string|null }}
   */
  _extractPricingInfo($, $pdp, ldJson) {
    const candidates = [];

    // ── Phase 1: find all MRP → {price, mrp, discount} groups ──
    $pdp.find('[style*="line-through"]').each((_, el) => {
      const $mrpEl = $(el);
      const mrpRaw = $mrpEl.text().trim();
      if (!/^₹?[\d,]+$/.test(mrpRaw) || mrpRaw.replace(/[₹,]/g, '').length < 3) return;
      const mrp = mrpRaw.startsWith('₹') ? mrpRaw : `₹${mrpRaw}`;

      // Walk up to find the container holding MRP + sale price + discount
      let $container = $mrpEl.parent();
      for (let level = 0; level < 8; level++) {
        if (!$container.length || $container.is('body')) break;

        const containerText = $container.text().trim();
        // Container must include a ₹-prefixed sale price
        if (!/₹[\d,]+/.test(containerText)) { $container = $container.parent(); continue; }

        // ── Sale price: first ₹ leaf that is NOT line-through ──
        let salePrice = null;
        $container.find('div, span').each((_, priceEl) => {
          const $p = $(priceEl);
          if ($p.children().length > 0) return;
          const pt = $p.text().trim();
          if (!/^₹[\d,]+$/.test(pt)) return;
          if (/line-through/i.test($p.attr('style') || '')) return;
          salePrice = pt;
          return false;
        });

        // ── Discount: ↓X% leaf within same container ──
        let discountText = null;
        $container.find('div, span').each((_, discEl) => {
          const $d = $(discEl);
          if ($d.children().length > 0) return;
          const dt = $d.text().trim();
          const dm = dt.match(/^[↓▼]\s*(\d+)%$/);
          if (dm) { discountText = `${dm[1]}% off`; return false; }
        });

        if (salePrice) {
          // Check if this container is inside a variant box
          const isVariantBox = /\d+\s*(?:TB|GB),?\s*\d+\.?\d*\s*inch/i.test(containerText) ||
                              /\d+\s*(?:TB|GB)\s*ROM/i.test(containerText);
          candidates.push({ price: salePrice, mrp, discount: discountText, isVariant: isVariantBox });
          break;
        }
        $container = $container.parent();
      }
    });

    // ── Phase 2: pick the best candidate ──
    const mainCandidates = candidates.filter(c => !c.isVariant);
    let result = mainCandidates.length > 0 ? mainCandidates[0] :
                 candidates.length > 0 ? candidates[0] : null;

    if (result) {
      // If the main candidate has no discount, try to inherit from a variant
      // candidate with the same price+MRP (this is the selected variant box)
      if (!result.discount) {
        const matchingVariant = candidates.find(
          c => c.isVariant && c.price === result.price && c.mrp === result.mrp && c.discount
        );
        if (matchingVariant) {
          result.discount = matchingVariant.discount;
        } else if (result.price && result.mrp) {
          // Compute discount from price and MRP
          const price = parseInt(result.price.replace(/[₹,]/g, ''), 10);
          const mrp = parseInt(result.mrp.replace(/[₹,]/g, ''), 10);
          if (mrp > price && mrp > 0) {
            const pct = Math.round(((mrp - price) / mrp) * 100);
            if (pct > 0 && pct < 100) result.discount = `${pct}% off`;
          }
        }
      }
      return result;
    }

    // ── Phase 3: fallback — scan individually ──
    let fallbackPrice = null;
    $pdp.find('div, span').each((_, el) => {
      const $el = $(el);
      if ($el.children().length > 2) return;
      const t = $el.text().trim();
      if (!/^₹[\d,]+$/.test(t)) return;
      const $parentAnchor = $el.closest('a[href*="/p/"], a[href*="pid="]');
      if ($parentAnchor.length > 0) return;
      const parentText = $el.parent().text().trim();
      if (/Buy at/i.test(parentText) && parentText.length < 30) return;
      fallbackPrice = t;
      return false;
    });

    // JSON-LD fallback for price only
    if (!fallbackPrice) {
      if (ldJson?.offers?.price) fallbackPrice = `₹${ldJson.offers.price}`;
      else if (ldJson?.offers?.lowPrice) fallbackPrice = `₹${ldJson.offers.lowPrice}`;
    }

    // Try older MRP patterns
    let fallbackMrp = null;
    $pdp.find('s, strike, del').each((_, el) => {
      const t = $(el).text().trim();
      if (/₹?[\d,]+/.test(t)) {
        fallbackMrp = t.startsWith('₹') ? t : `₹${t}`;
        return false;
      }
    });

    // Try older discount patterns
    let fallbackDiscount = null;
    $pdp.find('span, div').each((_, el) => {
      const t = $(el).text().trim();
      if (/^\d+%\s*off$/i.test(t)) { fallbackDiscount = t; return false; }
    });

    return { price: fallbackPrice, mrp: fallbackMrp, discount: fallbackDiscount };
  }

  // ─── Variants Extraction ────────────────────────────────────

  extractVariants($, warnings) {
    const variants = { selected: {}, available: {} };

    try {
      const dimensions = [
        { key: 'color',   re: /^(?:selected\s+)?colou?r$/i },
        { key: 'size',    re: /^(?:select(?:ed)?\s+)?size$/i },
        { key: 'storage', re: /^(?:(?:internal\s+)?storage|capacity)$/i },
        { key: 'ram',     re: /^(?:ram|(?:system\s+)?memory)$/i },
        { key: 'variant', re: /^(?:variant|configuration|model|edition)$/i },
        { key: 'pack_size', re: /^(?:pack\s+(?:of|size)|wattage|quantity)$/i },
      ];

      for (const dim of dimensions) {
        this._extractDimension($, dim.key, dim.re, variants);
      }
    } catch {
      warnings.push('variants extraction failed');
    }

    console.log('[FLIPKART] Variant mapping:', JSON.stringify(variants));
    return variants;
  }

  /**
   * Extract a single variant dimension (e.g. color, size, variant).
   *
   * Rewritten to handle:
   * - Image-based color swatches (extract alt/title from img)
   * - Unavailable variants (strikethrough price text)
   * - Variant price extraction
   * - Deeply nested Flipkart div structures
   */
  _extractDimension($, key, labelRe, variants) {
    let found = false;

    $('div, span, td, p, strong, b').each((_, labelEl) => {
      if (found) return false;

      const $label = $(labelEl);
      if (!$label || !$label.length) return;
      const ownText = this._ownText($, labelEl);

      if (!ownText || ownText.length > 50) return;
      let cleaned = ownText.replace(/[:\s.,]+$/, '').trim();
      cleaned = cleaned.replace(/^selected\s+/i, '').trim();
      if (!cleaned || !labelRe.test(cleaned)) return;

      // ── Detect selected value from adjacent text ──
      let selectedValue = null;

      const $labelParent = $label.parent();
      if (!$labelParent || !$labelParent.length) return;
      $labelParent.children().each((_, sib) => {
        if (sib === labelEl) return;
        const sibText = $(sib).text()?.trim() || '';
        if (sibText && sibText.length < 40 && !labelRe.test(sibText)) {
          selectedValue = sibText;
          return false;
        }
      });

      if (!selectedValue) {
        const parentText = ($labelParent.text() || '').trim();
        const remainder = parentText.replace(ownText, '').trim();
        if (remainder && remainder.length < 40 && !/^\d+$/.test(remainder)) {
          if (!/chart|guide|info|help/i.test(remainder)) {
            selectedValue = remainder.split(/\s{2,}/)[0].trim();
          }
        }
      }

      // ── Walk up to find the variant section container ──
      let $container = $labelParent;
      let optionsFound = false;

      for (let level = 0; level < 5; level++) {
        $container = $container.parent();
        if (!$container.length || $container.is('body') || $container.is('#container')) break;

        const containerText = $container.text().trim();
        if (containerText.length > 8000) break;

        // ── Strategy A: Anchor-based options (older layout) ──
        let $options = $container.find('a[href*="/p/"], a[href*="pid="]');
        if ($options.length < 2) {
          $options = $container.find('a[href*="/p/"], a[href*="pid="], li[role], button');
        }

        // ── Strategy B: Div-box options (2026 React layout) ──
        // Variant boxes are divs with min-height:75 or similar card-like containers
        let $divBoxes = $container.find('div[style*="min-height:75"], div[style*="min-height: 75"]');
        // Also try divs that look like variant cards (near the label, with price text)
        if ($divBoxes.length < 2 && key !== 'color') {
          // Look for sibling divs that contain both a variant name pattern and price/status
          const $candidateBoxes = [];
          $container.find('div').each((_, div) => {
            const $d = $(div);
            const dt = $d.text().trim().replace(/\s+/g, ' ');
            // Match patterns like "256 GB, 13.6 Inch ↓2%97,900₹95,490"
            if (dt.length > 10 && dt.length < 120 && /\d+\s*(?:GB|TB)/i.test(dt) && (/₹|out of stock|available in/i.test(dt))) {
              // Check it's a leaf-ish container (not a mega parent)
              const innerBoxes = $d.find('div[style*="min-height"]').length;
              if (innerBoxes === 0 || innerBoxes === 1) {
                $candidateBoxes.push(div);
              }
            }
          });
          if ($candidateBoxes.length >= 2) $divBoxes = $($candidateBoxes);
        }

        // Decide which set to process
        const useAnchors = $options.length >= 2 && $options.length <= 30;
        const useDivBoxes = $divBoxes.length >= 2 && $divBoxes.length <= 30;
        if (!useAnchors && !useDivBoxes) continue;

        const $items = useAnchors ? $options : $divBoxes;
        const optionItems = [];
        const seenOpt = new Set();

        $items.each((_, optEl) => {
          const $opt = $(optEl);
          if (!$opt || !$opt.length) return;
          let optText = ($opt.text() || '').trim().replace(/\s+/g, ' ');
          
          // Skip junk
          if (/add to cart|buy now|notify me|wishlist|share|pin\s?code|view plan|view emi/i.test(optText)) return;
          // Skip if text is the label itself
          if (labelRe.test(optText.replace(/[:\s]+$/, '').replace(/^selected\s+/i, ''))) return;

          const option = { name: null, price: null, image: null, selected: false, available: true };

          const $img = $opt.find('img').first();
          const imgAlt = ($img.attr('alt') || '').replace(/^Image$/i, '');
          const imgTitle = $opt.attr('title') || $img.attr('title') || '';
          const imgSrc = $img.attr('src') || $img.attr('data-src') || '';

          if (key === 'color') {
            option.name = imgAlt || imgTitle || null;
            if (!option.name && optText.length < 30 && optText.length > 0) {
              option.name = optText;
            }
            if (imgSrc) {
              option.image = imgSrc.replace(/\/\d+\/\d+\//g, '/100/100/');
            }
          } else {
            // Non-color: extract structured data from the box
            // For div boxes: leaf text contains name, price, discount, stock
            // e.g. leaves: ["256 GB, 13.6 Inch", "↓2%", "97,900", "₹95,490", "1 left"]
            const leaves = [];
            $opt.find('div, span').each((_, leaf) => {
              const $lf = $(leaf);
              if ($lf.children().length > 0) return;
              const lt = $lf.text().trim();
              if (lt) leaves.push(lt);
            });

            // First leaf that looks like a variant name (has GB/TB/inch etc)
            let variantName = null;
            for (const lf of leaves) {
              if (/\d+\s*(?:GB|TB)/i.test(lf) && lf.length < 60 && !/^[↓▼₹]/.test(lf)) {
                variantName = lf;
                break;
              }
            }
            if (!variantName) {
              // Fallback: first leaf with reasonable text
              for (const lf of leaves) {
                if (lf.length > 3 && lf.length < 60 && !/^[↓▼₹]/.test(lf) && !/^\d+[,\d]*$/.test(lf)) {
                  variantName = lf;
                  break;
                }
              }
            }

            // Extract price: find leaf starting with ₹
            for (const lf of leaves) {
              const pm = lf.match(/^₹([\d,]+)$/);
              if (pm) {
                option.price = parseInt(pm[1].replace(/,/g, ''), 10) || null;
                break;
              }
            }

            // If no leaves found, fall back to optText parsing
            if (!variantName) {
              const priceMatch = optText.match(/₹([\d,]+)/);
              if (priceMatch) {
                option.price = parseInt(priceMatch[1].replace(/,/g, ''), 10) || null;
                optText = optText.replace(/₹[\d,]+/g, '').replace(/[↓▼]\d+%/g, '').trim();
              }
              optText = optText.replace(/\s*\+\s*$/, '').replace(/\d+\s*left/i, '').replace(/out of stock/i, '').trim();
              variantName = optText || imgAlt || imgTitle || null;
            }

            option.name = variantName;
          }

          if (!option.name || option.name.length > 60) return;

          // Detect selection
          const style = $opt.attr('style') || '';
          const parentStyle = $opt.parent().attr('style') || '';
          const ariaSelected = $opt.attr('aria-selected') || $opt.attr('aria-checked') || '';
          if (/border.*solid.*#(?!e|d|c|f)/i.test(style) || /border.*solid.*#(?!e|d|c|f)/i.test(parentStyle) || ariaSelected === 'true') {
            option.selected = true;
          }
          // Match against selectedValue from label
          if (selectedValue && option.name && option.name.toLowerCase().includes(selectedValue.toLowerCase())) {
            option.selected = true;
          }

          // Detect unavailability
          const fullOptText = $opt.text().toLowerCase();
          // Check for struck-through text, but ignore struck-through prices (MRP display)
          let hasNameStrike = false;
          $opt.find('s, strike, del, [style*="line-through"]').each((_, struck) => {
            const struckText = $(struck).text().trim();
            // If the struck text is a price (all digits/commas/₹), it's an MRP display — NOT unavailability
            if (/^[₹\d,.\s]+$/.test(struckText)) return;
            hasNameStrike = true;
          });
          if (hasNameStrike || /coming soon|out of stock|unavailable|notify me/i.test(fullOptText)) {
            option.available = false;
          }
          // "Available in other colours" means not available in this variant config
          if (/available in other/i.test(fullOptText)) {
            option.available = false;
          }

          if (seenOpt.has(option.name)) return;
          seenOpt.add(option.name);
          optionItems.push(option);
        });

        if (optionItems.length >= 1) {
          variants.available[key] = optionItems;
          const sel = optionItems.find(o => o.selected);
          if (sel) {
            variants.selected[key] = sel.name;
          } else if (selectedValue) {
            variants.selected[key] = selectedValue;
          }
          optionsFound = true;
          found = true;
          break;
        }
      }

      if (!optionsFound && selectedValue) {
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

    const junkRe = /log\s*in|sign\s*up|sign\s*in|my\s*account|my\s*orders|my\s*cart|my\s*wishlist|help\s*centre|customer\s*care|gift\s*card|notification|advertise|download\s*app|sell\s*on|become\s*a\s*seller|keep\s*shopping|terms\s*of\s*use|privacy|policy|copyright|grievance|startek|footer|faq|pin\s*code|enter\s*delivery|check\s*availability|login\s*to/i;
    const ctaRe = /^apply$|^view\s*plan|^view\s*more|^t\s*&\s*c|^know\s*more|^\d{6}$|^change$/i;
    const kwRe = /bank\s*offer|credit\s*card|debit\s*card|cashback|emi|exchange|trade.?in|instant\s*discount|no\s*cost|partner\s*offer|special\s*price|flat\s*₹|upto\s*₹|up\s*to\s*₹|get\s*extra|coupon|off\s+on/i;

    const sectionHeaders = [
      { re: /^bank\s*offers?$/i, cat: 'bankOffers' },
      { re: /^exchange\s*offers?$/i, cat: 'exchangeOffers' },
      { re: /^(?:no\s*cost\s*)?emi$/i, cat: 'emiOffers' },
      { re: /^special\s*price$/i, cat: 'otherOffers' },
      { re: /^partner\s*offers?$/i, cat: 'otherOffers' },
      { re: /^available\s*offers?$/i, cat: null },
    ];

    const addClean = (text, cat) => {
      if (!text) return false;
      let c = text.replace(/\s+/g, ' ').trim();
      // Clean up concatenated words from DOM text nodes
      c = c.replace(/([a-z])([A-Z])/g, '$1 $2')
           .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
           .replace(/([a-zA-Z])(₹)/g, '$1 $2')
           .replace(/\b(off|cashback|discount)\s*(?=[A-Z])/g, '$1 ')
           .replace(/Apply|Know\s*More|View\s*T&C|Best\s*value\s*for\s*you|T&C\s*Apply/gi, '')
           .replace(/\s{2,}/g, ' ')
           .trim();
      if (c.length < 15 || c.length > 500) return false;
      if (junkRe.test(c) || ctaRe.test(c)) return false;
      if (seen.has(c)) return false;
      seen.add(c);
      if (cat) {
        offers[cat].push({ description: c, terms: null });
      } else {
        this._categorizeOffer(c, offers);
      }
      return true;
    };

    try {
      // ── Strategy 1: Find offer section headers and extract per-row offers ──
      const processedHeaders = new Set();

      $('div, span').each((_, el) => {
        const $el = $(el);
        if ($el.children().length > 0) return;
        const text = ($el.text() || '').trim();
        if (!text || text.length > 50) return;
        const normalized = text.replace(/[:\s]+$/, '').trim();
        if (!normalized || processedHeaders.has(normalized.toLowerCase())) return;

        for (const sec of sectionHeaders) {
          if (!sec.re.test(normalized)) continue;
          processedHeaders.add(normalized.toLowerCase());

          // Walk up to find the section container
          let $p = $el;
          for (let level = 0; level < 10; level++) {
            $p = $p.parent();
            if (!$p.length || $p.is('body') || $p.is('#container')) break;

            const kids = $p.children();
            if (kids.length < 2) continue;

            let hasOfferSibling = false;
            kids.each((_, ch) => {
              const ct = $(ch).text().trim();
              if (/₹[\d,]+/.test(ct) && ct.length > 20) hasOfferSibling = true;
            });
            if (!hasOfferSibling) continue;

            // Found container — now extract individual offer rows
            kids.each((_, ch) => {
              const $ch = $(ch);
              const ct = $ch.text().trim();
              const ctNorm = ct.replace(/[:\s]+$/, '').trim();
              if (sec.re.test(ctNorm) && ct.length < 30) return;
              if (ct.length > 20 && /₹[\d,]+/.test(ct)) {
                this._extractOfferCards($, $ch, sec.cat, addClean);
              }
            });
            break;
          }
          break;
        }
      });

      // ── Strategy 2: Direct offer row detection (modern Flipkart 2025-2026) ──
      // Each bank offer row is a div containing: bank icon + "₹X off" + "Apply" + bank name
      // Walk the DOM looking for divs that contain both ₹ amount and bank/card keywords
      if (offers.bankOffers.length < 3) {
        const bankRe = /ICICI|SBI|HDFC|Axis|Kotak|RBL|IndusInd|Federal|IDFC|Citi|Amex|Yes\s*Bank|AU\s*Small|BOB|Canara|PNB|Standard\s*Chartered|HSBC|American\s*Express|Bajaj\s*Finserv|Paytm|PhonePe|Mobikwik|Flipkart\s*Axis|OneCard|Fi\s*Money|Slice|Jupiter|CRED|Uni|Google\s*Pay|BHIM/i;
        
        $('div').each((_, el) => {
          const $el = $(el);
          const text = $el.text().trim().replace(/\s+/g, ' ');
          // Target leaf-ish divs (30-200 chars) with ₹ amount + bank name
          if (text.length < 25 || text.length > 200) return;
          if (!bankRe.test(text)) return;
          if (!/₹[\d,]+/.test(text)) return;
          // Skip if any child div also matches (we want leaf nodes)
          let hasMatchingChild = false;
          $el.children('div').each((_, child) => {
            const ct = $(child).text().trim();
            if (ct.length >= 25 && /₹[\d,]+/.test(ct) && bankRe.test(ct)) {
              hasMatchingChild = true;
              return false;
            }
          });
          if (hasMatchingChild) return;
          
          addClean(text, 'bankOffers');
        });
      }

      // ── Strategy 3: Exchange/EMI sections ──
      if (this._totalOffers(offers) < 2) {
        $('div, span').each((_, el) => {
          const $el = $(el);
          if ($el.children().length > 0) return;
          const text = ($el.text() || '').trim();
          if (!text || text.length > 30) return;
          const normalized = text.replace(/[:\s]+$/, '').trim();
          if (processedHeaders.has(normalized.toLowerCase())) return;

          for (const sec of sectionHeaders) {
            if (!sec.re.test(normalized)) continue;
            processedHeaders.add(normalized.toLowerCase());

            let $p = $el;
            for (let level = 0; level < 6; level++) {
              $p = $p.parent();
              if (!$p.length || $p.is('body')) break;
              const fullText = $p.text().trim().replace(/\s+/g, ' ');
              if (fullText.length > 30 && fullText.length < 500 && fullText !== text) {
                const offerText = fullText.replace(text, '').trim();
                if (offerText.length >= 15) {
                  addClean(offerText, sec.cat);
                }
                break;
              }
            }
            break;
          }
        });
      }

      // ── Strategy 4: Exchange offer extraction (2026 layout) ──
      if (offers.exchangeOffers.length === 0) {
        $('div, span').each((_, el) => {
          const $el = $(el);
          if ($el.children().length > 0) return;
          const t = $el.text().trim();
          if (!/^exchange\s*offer$/i.test(t)) return;

          let $p = $el;
          for (let level = 0; level < 6; level++) {
            $p = $p.parent();
            if (!$p.length || $p.is('body')) break;
            const fullText = $p.text().trim().replace(/\s+/g, ' ');
            const m = fullText.match(/up\s*to\s*₹([\d,]+)/i);
            if (m) {
              addClean(`Exchange offer: Up to ₹${m[1]} off`, 'exchangeOffers');
              break;
            }
            if (fullText.length > 300) break;
          }
          return false;
        });
      }

      // ── Strategy 5: Bank offer summary extraction (when individual offers not in HTML) ──
      if (offers.bankOffers.length === 0) {
        $('div, span').each((_, el) => {
          const $el = $(el);
          if ($el.children().length > 0) return;
          const t = $el.text().trim();
          if (!/^bank\s*offers?$/i.test(t)) return;

          let $p = $el;
          for (let level = 0; level < 7; level++) {
            $p = $p.parent();
            if (!$p.length || $p.is('body')) break;
            const fullText = $p.text().trim().replace(/\s+/g, ' ');
            // Look for "₹X,XXX off" pattern near the bank offers header
            const m = fullText.match(/₹([\d,]+)\s*off/i);
            if (m && fullText.length < 200) {
              addClean(`Bank offer: ₹${m[1]} off`, 'bankOffers');
              break;
            }
            if (fullText.length > 500) break;
          }
          return false;
        });
      }

      // ── Strategy 6: keyword scan fallback ──
      if (this._totalOffers(offers) === 0) {
        $('li, div').each((_, el) => {
          const $el = $(el);
          if ($el.find('li').length > 0 || $el.children('div').length > 3) return;
          const t = ($el.text() || '').trim().replace(/\s+/g, ' ');
          if (t.length >= 20 && t.length <= 350 && kwRe.test(t)) {
            addClean(t, null);
          }
        });
      }

      console.log('[FLIPKART] Offers found:', this._totalOffers(offers));
    } catch (e) {
      warnings.push('offers extraction partially failed: ' + e.message);
    }

    return offers;
  }

  _extractDelivery($) {
    const delivery = { available: null, eta: null, cost: null, seller: null };
    try {
      // Strategy 1: Find "Delivery" or "Delivery details" label and extract from its section
      $('div, span, h4, h3, strong').each((_, el) => {
        const ownT = this._ownText($, el);
        if (!ownT) return;
        const cleanD = ownT.replace(/[:\s]+$/, '').trim();
        if (!/^delivery(\s+details)?$/i.test(cleanD) && !/^delivery$/i.test(cleanD)) return;

        let $region = $(el).parent();
        for (let i = 0; i < 5; i++) {
          $region = $region.parent();
          if (!$region.length || $region.is('body')) break;
        }

        $region.find('span, div, p').each((_, c) => {
          const t = $(c).text().trim();
          if (t.length > 120 || t.length < 5) return;
          if (!delivery.eta && /\b(by|before|delivery\s+by)\s+\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) {
            delivery.eta = t.replace(/\s+/g, ' ');
            delivery.available = true;
          }
          if (!delivery.eta && /\b(by|before)\s+(sun|mon|tue|wed|thu|fri|sat)/i.test(t) && t.length < 80) {
            delivery.eta = t.replace(/\s+/g, ' ');
            delivery.available = true;
          }
          if (!delivery.eta && /free\s+delivery|get\s+it\s+by|usually\s+delivered/i.test(t) && t.length < 80) {
            delivery.eta = t.replace(/\s+/g, ' ');
            delivery.available = true;
          }
          // Delivery cost
          if (!delivery.cost && /₹\d+\s*delivery|delivery\s*₹\d+|delivery\s*charge/i.test(t)) {
            const match = t.match(/₹([\d,]+)/);
            delivery.cost = match ? `₹${match[1]}` : t;
          }
          if (!delivery.cost && /free\s*delivery|free\s*shipping/i.test(t)) {
            delivery.cost = 'FREE';
          }
        });

        if (delivery.eta) return false;
      });

      // Strategy 2: Broad scan for delivery info if strategy 1 failed
      if (!delivery.eta) {
        $('div, span').each((_, el) => {
          const $el = $(el);
          if ($el.children().length > 3) return;
          const t = $el.text().trim().replace(/\s+/g, ' ');
          if (t.length < 10 || t.length > 100) return;
          
          // "Delivery by 17 Jun" or "FREE delivery by Wed, Jun 18"
          if (/delivery\s+by\s+\w+/i.test(t) && /\d/.test(t)) {
            delivery.eta = t;
            delivery.available = true;
            return false;
          }
          // "Usually delivered in X days" or "Usually delivered in X-Y business days"
          if (/usually\s+delivered\s+in/i.test(t)) {
            delivery.eta = t;
            delivery.available = true;
            return false;
          }
          // "Not deliverable in your location" or "Not deliverable at your location"
          if (/^not\s+deliverable/i.test(t) && t.length < 60) {
            delivery.eta = t;
            delivery.available = false;
            return false;
          }
          // "Free Delivery" standalone
          if (/^free\s+delivery$/i.test(t)) {
            delivery.cost = 'FREE';
            delivery.available = true;
          }
          // "₹40 Delivery charge" or similar
          if (/₹\d+.*delivery/i.test(t) && t.length < 60) {
            const m = t.match(/₹([\d,]+)/);
            if (m) delivery.cost = `₹${m[1]}`;
            delivery.available = true;
          }
        });
      }

      // Seller
      const sellerEl = $('#sellerName span span, #sellerName span, #sellerName a').first();
      if (sellerEl.length) {
        delivery.seller = sellerEl.text().trim() || null;
      }
      if (!delivery.seller) {
        $('span, div').each((_, el) => {
          const t = $(el).text().trim();
          const m = t.match(/fulfilled\s+by\s+([A-Za-z0-9\s&.]+)/i);
          if (m && m[1] && m[1].trim().length < 50) {
            let sellerName = m[1].trim().replace(/\d+\.\d+$/, '').trim();
            if (sellerName) {
              delivery.seller = sellerName;
              return false;
            }
          }
        });
      }

      // If we found cost but no eta, still mark as available
      if (delivery.cost && !delivery.available) delivery.available = true;

      console.log('[FLIPKART] Delivery parsed:', delivery);
    } catch { /* delivery is optional */ }

    return delivery;
  }

  // ─── Highlights Extraction ────────────────────────────────

  _extractHighlights($) {
    const highlights = [];
    const specs = {};

    try {
      // ── HIGHLIGHTS ──
      // Flipkart 2024-2026 uses deeply nested div-only layouts (no UL/LI).
      // Structure from real DOM analysis:
      //   Leaf text "Product highlights" → walk up 3 levels → container has 2 children:
      //     child[0] = header wrapper, child[1] = data block
      //   Data block has deep nesting → eventually a div with 5 children (one per highlight)
      //   Each highlight item text is like "128 GB ROM Store upto 3000 photos"

      let hlDone = false;
      // Find the leaf text node for "Product highlights"
      $('div, span').each((_, el) => {
        if (hlDone) return false;
        const $el = $(el);
        if ($el.children().length > 0) return; // leaf only
        const text = $el.text().trim();
        if (!/^(?:product\s*|key\s*)?highlights?$/i.test(text)) return;

        // Walk up until we find a container where one sibling has highlight data
        let $p = $el;
        for (let level = 0; level < 8; level++) {
          $p = $p.parent();
          if (!$p.length || $p.is('body')) break;

          const fullText = $p.text().trim();
          // Check if this level contains data beyond just the header
          if (fullText.length > text.length + 30) {
            // Found container with header + data siblings
            // Extract from the data sibling (the child that isn't the header)
            $p.children().each((_, ch) => {
              const $ch = $(ch);
              const ct = $ch.text().trim();
              if (/^(?:product\s*|key\s*)?highlights?$/i.test(ct) || ct.length < 20) return;

              // Recursively find the div with 3+ children (the highlight item list)
              this._findHighlightItems($, $ch, highlights);
            });
            if (highlights.length > 0) {
              hlDone = true;
              return false;
            }
          }
        }
      });

      // Fallback: try UL/LI approach (older Flipkart layouts)
      if (highlights.length === 0) {
        $('div, span, h3, h4').each((_, el) => {
          if (highlights.length > 0) return false;
          const ownT = this._ownText($, el);
          if (!ownT) return;
          if (!/^(?:product\s+|key\s+)?highlights?$/i.test(ownT.replace(/[:\s]+$/, ''))) return;

          let $p = $(el).parent();
          for (let i = 0; i < 5; i++) {
            const $ul = $p.find('ul').first();
            if ($ul.length) {
              $ul.find('li').each((_, li) => {
                const t = $(li).text().trim();
                if (t && t.length < 200) highlights.push(t);
              });
              break;
            }
            $p = $p.parent();
            if (!$p.length || $p.is('body')) break;
          }
        });
      }

      // ── SPECIFICATIONS ──
      // Flipkart's modern layout puts specs behind a tab ("Specifications").
      // Specs data may NOT be in initial HTML for React-rendered pages.
      // Try table-based extraction first, then look for div-based key-value pairs.
      $('div, span, h3, h4, strong').each((_, el) => {
        if (Object.keys(specs).length > 0) return false;
        const ownT = this._ownText($, el);
        if (!ownT) return;
        const cleanS = ownT.replace(/[:\s]+$/, '').trim();
        if (!/^(?:product\s+)?specifications?$/i.test(cleanS)) return;

        let $p = $(el).parent();
        for (let i = 0; i < 6; i++) {
          // Try table rows
          $p.find('table tr').each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length >= 2) {
              const key = $(cells[0]).text().trim();
              const val = $(cells[1]).text().trim();
              if (key && val && key.length < 60 && val.length < 200) specs[key] = val;
            }
          });
          if (Object.keys(specs).length > 0) break;
          $p = $p.parent();
          if (!$p.length || $p.is('body')) break;
        }
      });

      console.log(`[FLIPKART] Highlights: ${highlights.length}, Specs: ${Object.keys(specs).length}`);
    } catch { /* optional */ }

    return { highlights, specs };
  }

  /**
   * Recursively find the highlight items container (a div with 3+ children,
   * where children have short meaningful text). Handles Flipkart's deeply
   * nested single-child div wrappers.
   */
  _findHighlightItems($, $node, highlights) {
    const kids = $node.children();
    if (kids.length === 0) return;

    // If this node has 3+ children with short text, these ARE the highlight items
    if (kids.length >= 3) {
      let validCount = 0;
      kids.each((_, kid) => {
        const t = $(kid).text().trim();
        // Skip items that just repeat the header text
        if (/^(?:key|product)?\s*highlights?$/i.test(t)) return;
        if (t.length >= 8 && t.length < 300) validCount++;
      });
      if (validCount >= 3) {
        kids.each((_, kid) => {
          const t = $(kid).text().trim();
          if (/^(?:key|product)?\s*highlights?/i.test(t)) return;
          if (t.length >= 8 && t.length < 300) highlights.push(t);
        });
        return;
      }
    }

    // Otherwise, drill into single-child wrappers
    if (kids.length <= 2) {
      kids.each((_, kid) => {
        this._findHighlightItems($, $(kid), highlights);
      });
    }
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Extract offer card text from a container. Handles both <li>-based
   * and <div>-based layouts (Flipkart uses divs for bank offer cards).
   *
   * Each bank offer card on Flipkart is a row like:
   *   [icon] [₹2,000 off] [Bank of Baroda] [Credit, Debit] [Apply]
   * These are individual divs with 3-5 inner elements.
   */
  /**
   * Extract individual offer cards from a data container.
   *
   * Real Flipkart DOM structure (2024-2026):
   *   Container → deeply nested → div with 3 children (card groups)
   *     Each group → deeply nested → div with 2 kids (the actual card)
   *   Card text: "₹6,545 offApplyFlipkart AxisCredit Card • Includes cashback"
   *
   * Strategy: recursively find "leaf offer" nodes — divs that contain ₹
   * amounts but whose children do NOT individually contain ₹ amounts.
   */
  _extractOfferCards($, $container, category, addClean) {
    let found = 0;
    const offerRe = /₹[\d,]+|cashback|discount/i;
    // Noise patterns to strip from offer text — handle concatenated text (no spaces)
    const noiseRe = /Apply|Know\s*More|View\s*T&C|Best\s*value\s*for\s*you|T&C\s*Apply/gi;
    const seen = new Set();

    // Pass 0: Concatenated text blob splitting (modern Flipkart layout)
    // Flipkart renders all offers as flat text without separator divs:
    //   "₹9,000 offApplyICICICredit Card₹9,000 offApplySBICredit Card..."
    // Split by bank/institution names that start new offer entries.
    const blobText = $container.text().trim().replace(/\s+/g, ' ');
    if (blobText.length > 60 && /₹[\d,]+/.test(blobText)) {
      // Split pattern: look for known bank/fintech names that start new offers
      const bankSplitRe = /(?=(?:ICICI|SBI|HDFC|Axis|Kotak|RBL|IndusInd|Federal|IDFC|Citi|Amex|Yes\s*Bank|AU\s*Small|BOB|Canara|PNB|Standard\s*Chartered|HSBC|American\s*Express|Bajaj\s*Finserv|Paytm|PhonePe|Mobikwik|Flipkart\s*Axis|OneCard|Fi\s*Money|Slice|Jupiter|CRED|Uni)[\s]*(?:Credit|Debit|Bank|Prepaid)?[\s]*(?:Card|EMI)?)/i;
      const chunks = blobText.split(bankSplitRe).filter(c => c && c.trim().length > 5);
      
      if (chunks.length >= 2) {
        // Reconstruct offers: each chunk after splitting starts with a bank name
        // Pair them: "₹9,000 offApply" + "ICICICredit Card" = "ICICI Credit Card ₹9,000 off"
        for (let i = 0; i < chunks.length; i++) {
          let chunk = chunks[i].trim()
            .replace(noiseRe, '')
            .replace(/([\d,]+)\s*off\s*(?=[A-Z])/g, '$1 off ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
            .replace(/\s{2,}/g, ' ')
            .trim();
          if (chunk.length >= 10 && /₹[\d,]+/.test(chunk)) {
            if (addClean(chunk, category)) found++;
          }
        }
        if (found >= 2) return found;
      }

      // Alternate split: by ₹ amounts (each offer has exactly one ₹ amount)
      if (found < 2) {
        found = 0;
        const amountParts = blobText.split(/(₹[\d,]+)/).filter(Boolean);
        if (amountParts.length >= 4) { // At least 2 offers (text + amount pairs)
          for (let i = 0; i < amountParts.length - 1; i++) {
            if (/^₹[\d,]+$/.test(amountParts[i])) {
              // Amount found — combine with preceding text and following text
              const before = (amountParts[i-1] || '').trim();
              const amount = amountParts[i];
              const after = (amountParts[i+1] || '').split(/₹/)[0].trim();
              let offerText = `${before} ${amount} ${after}`.trim()
                .replace(noiseRe, '')
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
                .replace(/\b(BHIM|GPay|PhonePe|Paytm)(UPI|Wallet)\b/g, '$1 $2')
                .replace(/\s{2,}/g, ' ')
                .trim();
              if (offerText.length >= 10) {
                if (addClean(offerText, category)) found++;
              }
            }
          }
          if (found >= 2) return found;
        }
      }
    }
    found = 0; // Reset for subsequent passes

    // Pass 1: Try <li> items first (older layout)
    $container.find('li').each((_, el) => {
      const $el = $(el);
      if ($el.find('li').length > 0) return;
      if (addClean($el.text(), category)) found++;
    });
    if (found > 0) return found;

    // Pass 2: Find ALL divs with ₹ amounts, then keep only the smallest
    // (leaf-level) ones. This avoids taking parent containers that combine
    // multiple cards into one text blob.
    //
    // Real Flipkart structure:
    //   Group[0] (textLen=135, has ₹) → wrappers → div (textLen=77, has ₹)
    //                                             → div (textLen=58, has ₹)
    // We want the textLen=77 and textLen=58 nodes, NOT the textLen=135 parent.

    const candidates = [];
    $container.find('div').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim().replace(/\s+/g, ' ');
      if (text.length < 15 || text.length > 200) return;
      if (!offerRe.test(text)) return;

      // Check: does any child div ALSO look like a COMPLETE offer card?
      // A child with just "₹6,545 offApply" (15 chars) is a fragment, not a card.
      // A real card is 30+ chars with ₹ amount AND bank/card name.
      let hasOfferChild = false;
      $el.children('div').each((_, child) => {
        const ct = $(child).text().trim();
        if (ct.length >= 30 && ct.length <= 200 && /₹[\d,]+/.test(ct)) {
          hasOfferChild = true;
          return false;
        }
      });

      if (!hasOfferChild) {
        // This is a leaf offer card — no child div has ₹ text
        candidates.push({ el, text });
      }
    });

    // Deduplicate: sort by text length DESC, reject if text is substring of accepted card
    candidates.sort((a, b) => b.text.length - a.text.length);
    const accepted = [];
    for (const c of candidates) {
      let cleaned = c.text
        .replace(noiseRe, '')
        // Fix missing spaces from concatenated DOM text nodes:
        // "offFlipkart" → "off Flipkart", "AxisCredit" → "Axis Credit"
        .replace(/(\b(?:off|cashback|discount))\s*(?=[A-Z])/g, '$1 ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        // Handle ACRONYM + Word: "SBICredit" → "SBI Credit", "BHIMUPI" → "BHIM UPI"
        .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
        // Handle word + ACRONYM: "MobikwikUPI" → "Mobikwik UPI"
        .replace(/([a-z])([A-Z]{2,})/g, '$1 $2')
        // Handle known adjacent acronyms: "BHIMUPI" → "BHIM UPI"
        .replace(/\b(BHIM|GPay|PhonePe|Paytm)(UPI|Wallet)\b/g, '$1 $2')
        // Clean up bullets: "UPI • Cashback" → "UPI • Cashback"
        .replace(/\s*•\s*/g, ' • ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (cleaned.length < 12) continue;
      // Skip if this is a substring of any already-accepted card
      if (accepted.some(a => a.includes(cleaned))) continue;
      accepted.push(cleaned);
      if (addClean(cleaned, category)) found++;
    }

    return found;
  }

  _categorizeOffer(text, offers) {
    if (/bank\s*offer|credit\s*card|debit\s*card|cashback|instant\s*discount|get\s*extra|flat\s*₹|upto\s*₹|up\s*to\s*₹/i.test(text)) {
      offers.bankOffers.push({ description: text, terms: null });
    } else if (/no\s*cost\s*emi|emi\s*available|emi\s*start|emi\s*from/i.test(text)) {
      offers.emiOffers.push({ description: text, terms: null });
    } else if (/exchange|trade.?in/i.test(text)) {
      offers.exchangeOffers.push({ description: text, terms: null });
    } else if (/special\s*price|partner\s*offer|combo\s*offer|supercoin/i.test(text)) {
      offers.otherOffers.push({ description: text, terms: null });
    } else if (/coupon|off\s+on|apply\s*coupon/i.test(text)) {
      offers.coupons.push({ description: text, code: null });
    } else if (/deliver|dispatch|shipping|free\s*delivery/i.test(text)) {
      offers.deliveryOffers.push({ description: text, terms: null });
    } else {
      offers.otherOffers.push({ description: text, terms: null });
    }
  }

  _totalOffers(offers) {
    return Object.values(offers).reduce((sum, arr) => sum + arr.length, 0);
  }
}

module.exports = FlipkartScraper;
