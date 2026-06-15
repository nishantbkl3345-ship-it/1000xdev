const BaseScraper = require('./base.scraper');

/**
 * AmazonScraper — extracts product data and offers from Amazon India/US pages.
 *
 * STRATEGY ORDER:
 * 1. JSON-LD structured data (most reliable — Amazon embeds it in script tags)
 * 2. DOM selectors scoped to #dp-container
 * 3. Fallback leaf-node scanning
 *
 * The page MUST be loaded with waitUntil: 'networkidle' because Amazon
 * renders product data via JavaScript after the initial DOM load.
 */
class AmazonScraper extends BaseScraper {
  constructor() {
    super('AMAZON');
  }

  getBrowserOptions() {
    return {
      waitForSelector: '#productTitle, #dp-container, #title_feature_div',
      selectorTimeout: 20000,
      postNavDelay: 3000, // extra 3s for JS hydration after DOM load
      maxRetries: 4,      // 3 proxy attempts + 1 direct fallback
    };
  }

  // ─── JSON-LD Extraction ──────────────────────────────────────

  _extractJsonLd($) {
    let data = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const parsed = JSON.parse(raw);
        // Amazon may have @type: Product directly or in @graph
        if (parsed['@type'] === 'Product') {
          data = parsed;
          return false;
        }
        if (Array.isArray(parsed['@graph'])) {
          const prod = parsed['@graph'].find(x => x['@type'] === 'Product');
          if (prod) { data = prod; return false; }
        }
      } catch { /* skip malformed JSON-LD */ }
    });
    return data;
  }

  // ─── Product Extraction ─────────────────────────────────────

  extractProduct($, warnings) {
    // Scope extraction to main PDP container — avoids footer, nav, recommendations
    const $pdp = $('#dp-container').length ? $('#dp-container') : $('body');

    // Try JSON-LD first (most reliable)
    const jsonLd = this._extractJsonLd($);

    // === TITLE ===
    const title =
      this._scopedText($pdp, '#productTitle', 'title', []) ||
      jsonLd?.name ||
      this._scopedText($pdp, '#title span', 'title', []) ||
      (() => {
        const t = $('title').text().trim();
        // "Product Name : Amazon.in" → extract before colon
        return t && t !== 'Amazon.in' ? t.split(/\s*[:|]\s*Amazon/i)[0].trim() || null : null;
      })();
    if (!title) warnings.push('title extraction failed');

    // === PRICE ===
    const priceText =
      this._scopedText($pdp, '.a-price .a-offscreen', 'price', []) ||
      this._scopedText($pdp, 'span.a-price-whole', 'price', []) ||
      this._scopedText($pdp, '#priceblock_dealprice', 'price', []) ||
      this._scopedText($pdp, '#priceblock_ourprice', 'price', []) ||
      this._scopedText($pdp, '#corePrice_feature_div .a-offscreen', 'price', []) ||
      this._scopedText($pdp, '#corePriceDisplay_desktop_feature_div .a-offscreen', 'price', []);

    // JSON-LD price fallback
    let jsonLdPrice = null;
    if (!priceText && jsonLd?.offers) {
      const offer = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
      jsonLdPrice = offer?.price || offer?.lowPrice;
    }

    if (!priceText && !jsonLdPrice) warnings.push('price extraction failed');

    // === MRP ===
    const mrpText =
      this._scopedText($pdp, '.basisPrice .a-offscreen', 'mrp', []) ||
      this._scopedText($pdp, '.a-text-price .a-offscreen', 'mrp', []) ||
      this._scopedText($pdp, '.a-price.a-text-price .a-offscreen', 'mrp', []);

    // === DISCOUNT ===
    const discount = this._scopedText($pdp, '.savingsPercentage', 'discount', []);

    // === RATING ===
    let rating = null;
    const ratingText = this._scopedText($pdp, '#acrPopover .a-icon-alt', 'rating', []);
    if (ratingText) {
      rating = parseFloat(ratingText.split(' ')[0]);
    } else if (jsonLd?.aggregateRating?.ratingValue) {
      rating = parseFloat(jsonLd.aggregateRating.ratingValue);
    }

    // === REVIEW COUNT ===
    let reviewCount = null;
    const reviewText = this._scopedText($pdp, '#acrCustomerReviewText', 'reviewCount', []);
    if (reviewText) {
      reviewCount = parseInt(reviewText.replace(/[^0-9]/g, ''), 10);
    } else if (jsonLd?.aggregateRating?.reviewCount) {
      reviewCount = parseInt(jsonLd.aggregateRating.reviewCount);
    }

    // === SELLER ===
    const seller =
      this._scopedText($pdp, '#sellerProfileTriggerId', 'seller', []) ||
      this._scopedText($pdp, '#merchant-info a', 'seller', []) ||
      this._scopedText($pdp, '#tabular-buybox .tabular-buybox-text a', 'seller', []);

    // === AVAILABILITY ===
    const availability =
      this._scopedText($pdp, '#availability span', 'availability', []) ||
      this._scopedText($pdp, '#outOfStock span', 'availability', []) ||
      (jsonLd?.offers?.availability?.includes('InStock') ? 'In Stock' : null) ||
      'Unknown';

    // === IMAGES ===
    const images = [];
    const seenImg = new Set();
    
    // Try JSON-LD images first
    if (jsonLd?.image) {
      const imgs = Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image];
      for (const src of imgs) {
        if (src && !seenImg.has(src)) { seenImg.add(src); images.push(src); }
      }
    }

    // DOM images
    $pdp.find('#altImages img, #imageBlock img, #landingImage').each((_, el) => {
      let src = $(el).attr('src') || $(el).attr('data-old-hires') || $(el).attr('data-a-dynamic-image');
      if (!src || !src.includes('images/I/')) return;
      // Try to get highest res by removing size constraints
      src = src.replace(/\._.*_\./, '.');
      if (!seenImg.has(src)) { seenImg.add(src); images.push(src); }
    });

    if (images.length === 0) {
      // Fallback: main hero image
      const mainImg = $pdp.find('#landingImage').attr('src') || $pdp.find('#imgBlkFront').attr('src');
      if (mainImg) images.push(mainImg);
      if (images.length === 0) warnings.push('images extraction failed');
    }

    // === DELIVERY ===
    const delivery = this._extractDelivery($, $pdp);

    return {
      title,
      price: this.parsePrice(priceText) || (jsonLdPrice ? parseFloat(jsonLdPrice) : null),
      mrp: this.parsePrice(mrpText),
      currency: 'INR',
      discount: discount || null,
      rating: isNaN(rating) ? null : rating,
      reviewCount: isNaN(reviewCount) ? null : reviewCount,
      seller: seller || null,
      availability: availability.trim(),
      images,
      delivery,
    };
  }

  // ─── Delivery Extraction ─────────────────────────────────────

  _extractDelivery($, $pdp) {
    const delivery = { available: null, eta: null, seller: null };
    try {
      // Delivery date
      const deliverySelectors = [
        '#mir-layout-DELIVERY_BLOCK .a-text-bold',
        '#mir-layout-DELIVERY_BLOCK-slot-DELIVERY_MESSAGE_C',
        '#deliveryBlockMessage',
        '#delivery-message',
        '#ddmDeliveryMessage',
        '#deliveryShortLine',
        '[data-feature-name="deliveryMessage"]',
        '#deliveryMessage_feature_div .a-text-bold',
      ];
      for (const sel of deliverySelectors) {
        const text = this.safeText($, sel, 'delivery', []);
        if (text && text.length > 3 && /\b(by|before|delivery|get it)\b/i.test(text)) {
          delivery.eta = text.replace(/\s+/g, ' ').trim();
          delivery.available = true;
          break;
        }
      }

      // FREE delivery check
      if (!delivery.eta) {
        $pdp.find('span, div').each((_, el) => {
          const t = $(el).text().trim();
          if (/free\s+delivery/i.test(t) && t.length < 80) {
            delivery.eta = t.replace(/\s+/g, ' ').trim();
            delivery.available = true;
            return false;
          }
        });
      }

      // Seller
      const sellerText =
        this._scopedText($pdp, '#sellerProfileTriggerId', 'seller', []) ||
        this._scopedText($pdp, '#merchant-info a', 'seller', []);
      if (sellerText) delivery.seller = sellerText;

    } catch { /* delivery is optional */ }
    return delivery;
  }

  // ─── Variants Extraction ────────────────────────────────────

  extractVariants($, warnings) {
    const variants = { selected: {}, available: {} };

    try {
      // Amazon renders variant pickers inside #twister or #twister_feature_div
      const $twister = $('#twister, #twister_feature_div').first();
      if (!$twister.length) return variants;

      // ── Strategy 0: Parse embedded JSON state (most reliable) ──
      // Amazon embeds variant data in <script type="a-state"> inside #twister.
      // This contains exact names, ASINs, images, and selection states.
      try {
        $twister.find('script[type="a-state"]').each((_, scriptEl) => {
          const raw = $(scriptEl).html();
          if (!raw || !raw.includes('sortedDimValuesForAllDims')) return;

          const stateData = JSON.parse(raw);
          const dims = stateData?.sortedDimValuesForAllDims;
          if (!dims || typeof dims !== 'object') return;

          for (const [dimKey, dimValues] of Object.entries(dims)) {
            if (!Array.isArray(dimValues) || dimValues.length === 0) continue;

            // "color_name" → "color", "size_name" → "size"
            const key = dimKey.replace(/_name$/, '').replace(/_/g, ' ');
            const options = [];

            for (const val of dimValues) {
              const name = val.dimensionValueDisplayText;
              if (!name) continue;

              const isSelected = val.dimensionValueState === 'SELECTED';
              if (isSelected) variants.selected[key] = name;

              // Extract image URL
              const image = val.imageAttribute?.url || null;

              // Extract ASIN
              const asin = val.defaultAsin || null;

              // Extract savings percentage from slot data
              const savings = val.slots?.[0]?.displayData?.apexPriceViewModel?.apexPriceKataView?.savingsPercentage || null;

              options.push({
                name,
                price: null, // prices are not in this JSON, only savings %
                image,
                asin,
                selected: isSelected,
                savings: savings ? `-${savings}` : null,
              });
            }

            if (options.length > 0) {
              variants.available[key] = options;
            }
          }
        });
      } catch {
        // JSON parsing failed, fall through to DOM strategies
      }

      // If JSON strategy worked, skip DOM-based extraction
      if (Object.keys(variants.available).length > 0) {
        return variants;
      }

      // Each variant dimension is a <div> with id like "variation_color_name", "variation_size_name"
      $twister.find('[id^="variation_"]').each((_, dimEl) => {
        const $dim = $(dimEl);
        const dimId = $dim.attr('id') || '';

        // Extract dimension name from id: "variation_color_name" → "color"
        const nameMatch = dimId.match(/^variation_(.+?)_name$/);
        if (!nameMatch) return;
        const dimKey = nameMatch[1].replace(/_/g, '_').toLowerCase();

        // Extract human-readable label (e.g. "Color:" or "Size:")
        const rawLabel = $dim.find('.a-form-label, .a-size-base').first().text().replace(/[:\s]/g, '').toLowerCase();
        const key = rawLabel || dimKey;

        const options = [];
        const seen = new Set();
        let selectedValue = null;

        // Each option is an <li> inside the swatches list
        $dim.find('li[id^="color_name_"], li[id^="size_name_"], li[data-defaultasin]').each((_, optEl) => {
          const $opt = $(optEl);
          const name =
            $opt.attr('title')?.replace(/^Click to select\s*/i, '').trim() ||
            $opt.find('.a-size-base').text().trim() ||
            $opt.find('img').attr('alt')?.trim();

          if (!name || seen.has(name)) return;
          seen.add(name);

          // Amazon's stable selected class is "swatchSelect"
          const isSelected =
            $opt.hasClass('swatchSelect') ||
            $opt.attr('class')?.includes('swatchSelect') ||
            false;

          if (isSelected) selectedValue = name;

          // ── Extract per-variant PRICE ──
          // Amazon shows prices like "₹549.00" below each swatch thumbnail
          let variantPrice = null;
          const priceEl =
            $opt.find('.twisterSwatchPrice').text().trim() ||
            $opt.find('.a-color-price').text().trim() ||
            $opt.find('.a-size-mini').text().trim() ||
            $opt.find('.a-price .a-offscreen').text().trim() ||
            $opt.find('[class*="Price"]').text().trim();
          if (priceEl) {
            const cleaned = priceEl.replace(/[₹,\s]/g, '');
            const num = parseFloat(cleaned);
            if (!isNaN(num) && num > 0) variantPrice = num;
          }

          // ── Extract per-variant IMAGE ──
          const variantImage =
            $opt.find('img').attr('src')?.replace(/\._.*_\./, '.') || null;

          // ── Extract ASIN for variant linking ──
          const variantAsin = $opt.attr('data-defaultasin') || $opt.attr('data-dp-url')?.match(/dp\/([A-Z0-9]+)/)?.[1] || null;

          options.push({
            name,
            price: variantPrice,
            image: variantImage,
            asin: variantAsin,
            selected: isSelected,
          });
        });

        // Fallback: button-based variant pickers (e.g. storage, RAM)
        if (options.length === 0) {
          $dim.find('.a-button-text, option').each((_, optEl) => {
            const name = $(optEl).text().trim();
            if (!name || seen.has(name) || name.length > 60) return;
            seen.add(name);

            const $btn = $(optEl).closest('.a-button, option');
            const isSelected =
              $btn.hasClass('a-button-selected') ||
              $btn.attr('selected') !== undefined;

            if (isSelected) selectedValue = name;
            options.push({ name, price: null, image: null, asin: null, selected: isSelected });
          });
        }

        if (options.length > 0) {
          variants.available[key] = options;
          if (selectedValue) variants.selected[key] = selectedValue;
        }
      });

      // ── Fallback: label-based variant detection ──────────────────
      // Some Amazon products DON'T use [id^="variation_"] containers.
      // Instead, they render variant labels like "Colour: Olive" as plain
      // spans inside #twister, with radio-button groups nearby.
      // Only fire this if the primary strategy found nothing.
      if (Object.keys(variants.available).length === 0) {
        // Step 1: Find variant dimension labels (e.g. "Colour:", "Size:")
        // and their selected values from #twister
        const dimensionLabels = [];

        $twister.find('span, label, .a-form-label').each((_, labelEl) => {
          const rawText = $(labelEl).clone().children().remove().end().text().trim();
          const labelMatch = rawText.match(/^(colou?r|size|style|pattern|design|material|edition|configuration)\s*:?\s*$/i);
          if (!labelMatch) return;

          const key = labelMatch[1].toLowerCase().replace(/colour/, 'color');

          // The selected value is the next sibling span
          const selectedSpan = $(labelEl).next('span').text().trim();

          if (selectedSpan && selectedSpan.length < 50 && selectedSpan !== rawText) {
            variants.selected[key] = selectedSpan;
          }

          // Store the label element's parent for scoping
          dimensionLabels.push({ key, element: labelEl });
        });

        // Step 2: Find variant options by looking for price-bearing containers
        // NEAR the label (in the same section), not all radio buttons in #twister
        if (dimensionLabels.length > 0) {
          for (const { key } of dimensionLabels) {
            const options = [];
            const seenPrices = new Set();
            const priceRegex = /₹([\d,]+\.?\d*)/g;

            // Scan all text in #twister for price containers that come AFTER
            // the label. We identify variant buttons by looking for containers
            // that have exactly a price pattern and are part of a button group.
            $twister.find('span').each((_, spanEl) => {
              const $span = $(spanEl);
              const text = $span.text().trim().replace(/\s+/g, ' ');

              // Look for spans containing exactly price patterns like "₹1,348.00 ₹3,799.00"
              // These are the variant button containers
              const priceMatches = [...text.matchAll(priceRegex)];
              if (priceMatches.length < 1 || priceMatches.length > 3) return;

              // Skip if this span has too many children (it's a large container)
              if ($span.children().length > 5) return;

              // Check if this contains a radio button (variant selector)
              const hasRadio = $span.find('input[role="radio"]').length > 0 ||
                $span.parent().find('input[role="radio"]').length > 0;
              if (!hasRadio) return;

              const salePrice = parseFloat(priceMatches[0][1].replace(/,/g, ''));
              if (isNaN(salePrice) || salePrice <= 0) return;

              // Deduplicate by price (since the same price can appear in nested spans)
              const priceKey = salePrice.toFixed(2);
              if (seenPrices.has(priceKey)) return;
              seenPrices.add(priceKey);

              options.push({
                name: null,
                price: salePrice,
                image: null,
                asin: null,
                selected: false,
              });
            });

            // Assign names to options
            if (options.length > 0) {
              const selectedName = variants.selected[key];

              // Try to get names from li[data-defaultasin] or img alt attributes
              const namesList = [];
              $twister.find('li[data-defaultasin]').each((_, el) => {
                const title = $(el).attr('title')?.replace(/^Click to select\s*/i, '').trim();
                const imgAlt = $(el).find('img').attr('alt')?.trim();
                if (title) namesList.push(title);
                else if (imgAlt) namesList.push(imgAlt);
              });

              // Assign names: use detected names or generate Option N
              options.forEach((opt, i) => {
                if (namesList[i]) {
                  opt.name = namesList[i];
                } else if (i === 0 && selectedName) {
                  opt.name = selectedName;
                } else {
                  opt.name = `Option ${i + 1}`;
                }

                // Mark selected
                if (selectedName && opt.name === selectedName) {
                  opt.selected = true;
                }
              });

              // If no option was marked selected but we have a selected name, mark first
              if (selectedName && !options.some(o => o.selected) && options.length > 0) {
                options[0].selected = true;
              }

              variants.available[key] = options;
            }
          }
        }
      }

      // Fallback: selected value from the label row (e.g. "Color: Blue")
      // Amazon shows the selected value next to the label in .selection span
      $twister.find('.a-row .selection, .a-row .a-color-secondary').each((_, el) => {
        const text = $(el).text().trim();
        if (!text || text.length > 50) return;
        const $row = $(el).closest('[id^="variation_"]');
        const rowId = $row.attr('id') || '';
        const rowMatch = rowId.match(/^variation_(.+?)_name$/);
        if (rowMatch) {
          const k = rowMatch[1].replace(/_/g, '_').toLowerCase();
          if (!variants.selected[k]) variants.selected[k] = text;
        }
      });
    } catch {
      warnings.push('variants extraction failed');
    }

    return variants;
  }

  // ─── Offers Extraction ──────────────────────────────────────

  extractOffers($, warnings) {
    const offers = this.emptyOffers();
    const seen = new Set();

    try {
      // ── Strategy 1: Individual offer cards from #soWidget ──────
      // Amazon's offers carousel: each card is a separate offer.
      // CRITICAL: scan LEAF elements first (most granular) to avoid
      // parent text swallowing child offers into one big string.
      $('#soWidget .a-carousel-card').each((_, card) => {
        const $card = $(card);
        // Each card has a header (e.g. "Cashback", "Bank Offer", "Partner Offers")
        // and a description body. Extract them separately for clean output.
        const headerEl = $card.find('.soHeadline, .so-header, .a-text-bold, h3, h4').first();
        const header = headerEl.text().trim();

        // Get description — try the specific description span/div first
        let desc = '';
        const descEl = $card.find('.soContent, .so-description, .a-truncate-full, .a-truncate-cut').first();
        if (descEl.length) {
          // Prefer the untruncated version
          const fullText = $card.find('.a-truncate-full').text().trim();
          desc = fullText || descEl.text().trim();
        }

        // Fallback: if no structured desc, take the whole card text minus the header
        if (!desc) {
          desc = $card.text().trim().replace(/\s+/g, ' ');
          // Remove the header from the beginning if it's duplicated
          if (header && desc.startsWith(header)) {
            desc = desc.slice(header.length).trim();
          }
        }

        // Also extract the "X offers" link text (e.g. "38 offers Bank Offer")
        const offersCountText = $card.find('[class*="offer"], a').text().match(/(\d+)\s*offers?/i);
        const offersCount = offersCountText ? offersCountText[0] : '';

        // Build the full offer string
        let fullOffer = '';
        if (header && desc) {
          fullOffer = `${header}: ${desc}`;
        } else {
          fullOffer = desc || header || $card.text().trim().replace(/\s+/g, ' ');
        }

        if (!fullOffer || fullOffer.length < 10) return;

        // Deduplicate by a normalized short key (first 60 chars)
        const dedupKey = fullOffer.substring(0, 60).toLowerCase().replace(/\s+/g, '');
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);

        // If there's an offers count, append it
        if (offersCount && !fullOffer.includes(offersCount)) {
          fullOffer += ` (${offersCount})`;
        }

        this._categorizeOffer(fullOffer, offers);
      });

      // ── Strategy 2: Promotions feature div ─────────────────────
      // Individual promotion items (not parent rows)
      this._scanOfferLeaves($, [
        '#promotions_feature_div li',
        '#promotions_feature_div .a-carousel-card',
        '#itembox-InstantBankDiscount li',
        '#itembox-InstantBankDiscount .a-carousel-card',
      ], offers, seen);

      // ── Strategy 3: Offers from "offers" feature div ───────────
      this._scanOfferLeaves($, [
        '#offersAccordion li',
        '[data-feature-name="offers"] li',
        '[data-feature-name="offers"] .a-carousel-card',
      ], offers, seen);

      // ── Strategy 4: Scoped fallback — only inside offer containers
      if (this._totalOffers(offers) === 0) {
        this._scanOfferLeaves($, [
          '[id*="offer"] li',
          '[id*="Offer"] li',
          '[class*="offer"] li',
          '#soWidget .a-row',
          '#soWidget li',
        ], offers, seen);
      }

      // ── Coupons ────────────────────────────────────────────────
      const couponText =
        this.safeText($, '#couponText', 'coupon', []) ||
        this.safeText($, '#vpcButton', 'coupon', []) ||
        this.safeText($, '[id*="coupon"] .a-button-text', 'coupon', []) ||
        this.safeText($, '.couponBadge', 'coupon', []);
      if (couponText) {
        const cleaned = couponText.replace(/\s+/g, ' ').trim();
        const dk = cleaned.substring(0, 60).toLowerCase().replace(/\s+/g, '');
        if (!seen.has(dk)) {
          seen.add(dk);
          offers.coupons.push({ description: cleaned, code: null });
        }
      }

      // ── EMI ────────────────────────────────────────────────────
      const emiText =
        this.safeText($, '#emi-feature-div', 'emi', []) ||
        this.safeText($, '#itembox-EmiUpsell', 'emi', []) ||
        this.safeText($, '[data-feature-name="emiUpsell"]', 'emi', []);
      if (emiText) {
        const cleaned = emiText.replace(/\s+/g, ' ').trim();
        if (cleaned.length > 10) {
          const dk = cleaned.substring(0, 60).toLowerCase().replace(/\s+/g, '');
          if (!seen.has(dk)) {
            seen.add(dk);
            offers.emiOffers.push({ description: cleaned, terms: null });
          }
        }
      }

      // ── Exchange ───────────────────────────────────────────────
      const exchangeText =
        this.safeText($, '#tradeInButton_feature_div', 'exchange', []) ||
        this.safeText($, '#buyNew_noncbb', 'exchange', []) ||
        this.safeText($, '#trade-in-description', 'exchange', []) ||
        this.safeText($, '[data-feature-name="tradeIn"]', 'exchange', []);
      if (exchangeText && /exchange|trade.?in/i.test(exchangeText)) {
        const cleaned = exchangeText.replace(/\s+/g, ' ').trim();
        const dk = cleaned.substring(0, 60).toLowerCase().replace(/\s+/g, '');
        if (!seen.has(dk)) {
          seen.add(dk);
          offers.exchangeOffers.push({ description: cleaned, terms: null });
        }
      }

      // ── Delivery ───────────────────────────────────────────────
      const deliverySelectors = [
        '#mir-layout-DELIVERY_BLOCK .a-text-bold',
        '#deliveryBlockMessage',
        '#delivery-message',
        '#ddmDeliveryMessage',
        '#deliveryShortLine',
        '[data-feature-name="deliveryMessage"]',
      ];
      for (const sel of deliverySelectors) {
        const text = this.safeText($, sel, 'delivery', []);
        if (text) {
          const cleaned = text.replace(/\s+/g, ' ').trim();
          if (cleaned.length > 5) {
            const dk = cleaned.substring(0, 60).toLowerCase().replace(/\s+/g, '');
            if (!seen.has(dk)) {
              seen.add(dk);
              offers.deliveryOffers.push({ description: cleaned, terms: null });
            }
          }
        }
      }
    } catch {
      warnings.push('offers extraction partially failed');
    }

    return offers;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Extract text from a selector scoped to a container (e.g. #dp-container).
   * Prevents leaking data from ads, footer, recommendations.
   */
  _scopedText($container, selector, fieldName, warnings) {
    try {
      const text = $container.find(selector).first().text().trim();
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
   * Scan LEAF offer elements — most granular items, not parent containers.
   * Uses short-key dedup (first 60 chars normalized) so a parent container's
   * text won't accidentally shadow its individual child items.
   */
  _scanOfferLeaves($, selectors, offers, seen) {
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const $el = $(el);
        // Skip elements that have child offer elements (they're containers, not leaves)
        if ($el.find('.a-carousel-card, li').length > 0 && $el.children().length > 2) return;

        const text = $el.text().trim().replace(/\s+/g, ' ');
        if (!text || text.length < 15 || text.length > 500) return;

        const dedupKey = text.substring(0, 60).toLowerCase().replace(/\s+/g, '');
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);

        this._categorizeOffer(text, offers);
      });
    }
  }

  /** Route offer text into the correct category by keyword matching. */
  _categorizeOffer(text, offers) {
    if (/bank\s*offer|credit\s*card|debit\s*card|cashback|instant\s*discount/i.test(text)) {
      offers.bankOffers.push({ description: text, terms: null });
    } else if (/no\s*cost\s*emi|emi\s*available|emi\s*start|emi\s*option/i.test(text)) {
      offers.emiOffers.push({ description: text, terms: null });
    } else if (/exchange|trade.?in/i.test(text)) {
      offers.exchangeOffers.push({ description: text, terms: null });
    } else if (/coupon|apply.*off|clip.*coupon/i.test(text)) {
      offers.coupons.push({ description: text, code: null });
    } else if (/deliver|shipping|free.*delivery|dispatch/i.test(text)) {
      offers.deliveryOffers.push({ description: text, terms: null });
    } else if (/gst|partner|business|invoice/i.test(text)) {
      offers.otherOffers.push({ description: text, terms: null });
    } else {
      offers.otherOffers.push({ description: text, terms: null });
    }
  }

  /** Count total offers across all categories. */
  _totalOffers(offers) {
    return Object.values(offers).reduce((sum, arr) => sum + arr.length, 0);
  }
}

module.exports = AmazonScraper;
