const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const config = require('../config');
const { SCRAPE_TIMEOUT } = require('../config/constants');
const { getRandomUserAgent } = require('./user-agent');
const { retry } = require('./retry');
const proxyManager = require('./proxy.manager');
const logger = require('./logger');
const { ScraperTimeoutError, BlockedPageError } = require('./errors');

// Apply stealth plugin — patches many headless browser fingerprints
// (navigator.webdriver, chrome runtime, plugins, WebGL, canvas, etc.)
chromium.use(StealthPlugin());

/**
 * Resource types and domains to block for speed.
 * We only need document + scripts + XHR/fetch for product data extraction.
 */
const BLOCKED_RESOURCE_TYPES = new Set([
  'image', 'media', 'font', 'websocket', 'ping',
]);

const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.com', 'facebook.net', 'fbcdn.net',
  'hotjar.com', 'hotjar.io',
  'googlesyndication.com', 'googleadservices.com',
  'amazon-adsystem.com', 'adskeeper.com', 'adnxs.com',
  'scorecardresearch.com', 'chartbeat.com', 'newrelic.com',
  'sentry.io', 'bugsnag.com', 'clarity.ms',
];

/**
 * Patterns in DOM text that indicate a blocked / anti-bot page.
 */
const BLOCKED_PAGE_PATTERNS = [
  /access\s*denied/i,
  /robot\s*check/i,
  /enter\s*the\s*characters/i,
  /temporarily\s*blocked/i,
  /verify\s*you\s*are\s*human/i,
  /unusual\s*traffic/i,
  /checking\s*your\s*browser/i,
  /bot\s*protect/i,
  /automated\s*access/i,
  /validatecaptcha/i,         // Amazon CAPTCHA form action
  /opfcaptcha/i,              // Amazon CAPTCHA domain
];

/**
 * Viewport pool — used for adaptive retry (different screen profile per attempt).
 */
const VIEWPORT_POOL = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
];

/**
 * BrowserManager — singleton stealth Playwright browser, fresh context per request.
 *
 * Uses playwright-extra with the Stealth plugin to bypass bot-protection
 * systems like Akamai Bot Manager (used by Meesho) and Cloudflare.
 */
class BrowserManager {
  constructor() {
    this.browser = null;
  }

  /**
   * Parse a proxy URL (potentially with credentials) into Playwright's format.
   * Input:  "http://user:pass@host:port"
   * Output: { server: "http://host:port", username: "user", password: "pass" }
   */
  _parseProxy(proxyUrl) {
    if (!proxyUrl) return null;
    try {
      const parsed = new URL(proxyUrl);
      const result = { server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}` };
      if (parsed.username) result.username = decodeURIComponent(parsed.username);
      if (parsed.password) result.password = decodeURIComponent(parsed.password);
      return result;
    } catch {
      // If URL parsing fails, return as-is (legacy socks5://host:port format)
      return { server: proxyUrl };
    }
  }

  /** Launch browser if not already running. */
  async init() {
    if (!this.browser || !this.browser.isConnected()) {
      logger.info('Launching Playwright Chromium browser (stealth mode)');
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--window-size=1366,768',
        ],
      });
    }
  }

  /**
   * Fetch a page's rendered HTML with retry, proxy rotation, UA rotation,
   * resource blocking for speed, and bot-protection challenge handling.
   *
   * @param {string} url — target URL
   * @param {Object} options
   * @param {number}   options.timeout         — navigation timeout (default: SCRAPE_TIMEOUT)
   * @param {string}   options.waitForSelector  — CSS selector to wait for before extracting HTML
   * @param {number}   options.challengeWaitMs  — max ms to poll for bot-challenge resolution (0 = skip)
   * @param {boolean}  options.blockResources   — whether to block images/fonts/tracking (default: true)
   * @returns {Promise<string>} — rendered HTML string
   */
  async getPage(url, options = {}) {
    await this.init();

    const timeout = options.timeout || config.scrapeTimeout || SCRAPE_TIMEOUT;

    // Determine platform for proxy routing
    const platform = options.platform ||
      (url.includes('meesho') ? 'MEESHO' :
       url.includes('amazon') ? 'AMAZON' :
       url.includes('flipkart') ? 'FLIPKART' : null);

    try {
      return await retry(
        async (attempt) => {
          // On last attempt, try direct connection (no proxy) as fallback
          const maxAttempts = options.maxRetries || config.maxRetries;
          const useDirectFallback = attempt === maxAttempts;
          const proxyRaw = useDirectFallback ? null : proxyManager.getProxy(platform);
          if (useDirectFallback) {
            logger.info(`[BROWSER] Attempt ${attempt}: trying DIRECT connection (no proxy)`);
          }
          const proxyConfig = this._parseProxy(proxyRaw);
          const userAgent = getRandomUserAgent();
          let context;
          const t0 = Date.now();

          try {
            // Adaptive viewport — rotate per attempt for fingerprint diversity
            const vp = VIEWPORT_POOL[(attempt - 1) % VIEWPORT_POOL.length];

            // Merge base headers with scraper-provided extra headers
            const baseHeaders = {
              'Accept-Language': 'en-IN,en;q=0.9',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24", "Google Chrome";v="137"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Windows"',
            };
            const mergedHeaders = { ...baseHeaders, ...(options.extraHeaders || {}) };

            context = await this.browser.newContext({
              userAgent,
              viewport: vp,
              screen: vp,
              deviceScaleFactor: 1,
              hasTouch: false,
              isMobile: false,
              locale: 'en-IN',
              timezoneId: 'Asia/Kolkata',
              geolocation: { latitude: 19.076, longitude: 72.8777 },
              permissions: [],
              ...(proxyConfig ? { proxy: proxyConfig } : {}),
              ignoreHTTPSErrors: true,
              extraHTTPHeaders: mergedHeaders,
            });

            const page = await context.newPage();

            logger.info(`[BROWSER] Fingerprint applied`, { viewport: `${vp.width}x${vp.height}`, attempt });

            // ── Stealth hardening — runs before page scripts ────────
            await page.addInitScript(() => {
              // 1. navigator.webdriver — delete the automation flag
              Object.defineProperty(navigator, 'webdriver', { get: () => false });

              // 2. chrome.runtime — stub to look like real Chrome
              if (!window.chrome) window.chrome = {};
              if (!window.chrome.runtime) {
                window.chrome.runtime = {
                  connect: () => {},
                  sendMessage: () => {},
                  onMessage: { addListener: () => {} },
                };
              }

              // 3. navigator.plugins — inject realistic plugin array
              Object.defineProperty(navigator, 'plugins', {
                get: () => [
                  { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                  { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                  { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                ],
              });

              // 4. navigator.languages — realistic language list
              Object.defineProperty(navigator, 'languages', {
                get: () => ['en-IN', 'en-US', 'en'],
              });

              // 5. Permissions API — prevent "prompt" detection
              if (navigator.permissions) {
                const origQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = (params) => {
                  if (params.name === 'notifications') {
                    return Promise.resolve({ state: 'denied', onchange: null });
                  }
                  return origQuery(params);
                };
              }

              // 6. Screen dimensions consistency — match viewport dynamically
              const w = window.innerWidth || 1366;
              const h = window.innerHeight || 768;
              Object.defineProperty(screen, 'availWidth', { get: () => w });
              Object.defineProperty(screen, 'availHeight', { get: () => h - 40 });
              Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
              Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
            });

            // ── Block resources for speed ─────────────────────────────
            if (options.blockResources === 'meesho') {
              // Smart filter: allow documents, scripts, XHR, fetch, CSS,
              // and meeshocdn images. Block everything else.
              await page.route('**/*', (route) => {
                const req = route.request();
                const resourceType = req.resourceType();
                const reqUrl = req.url();

                // Always allow core page resources
                if (['document', 'script', 'xhr', 'fetch', 'stylesheet'].includes(resourceType)) {
                  // Still block known trackers
                  const isTracker = BLOCKED_DOMAINS.some((d) => reqUrl.includes(d));
                  return isTracker ? route.abort() : route.continue();
                }

                // Allow meeshocdn images (product images)
                if (resourceType === 'image' && reqUrl.includes('meeshocdn')) {
                  return route.continue();
                }

                // Block everything else (fonts, media, non-CDN images, websockets, etc.)
                return route.abort();
              });
            } else if (options.blockResources !== false) {
              await page.route('**/*', (route) => {
                const req = route.request();
                const resourceType = req.resourceType();
                const reqUrl = req.url();

                if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
                  return route.abort();
                }

                const isBlocked = BLOCKED_DOMAINS.some((d) => reqUrl.includes(d));
                if (isBlocked) {
                  return route.abort();
                }

                return route.continue();
              });
            }

            logger.info(`Attempt ${attempt}: navigating to URL`, {
              url,
              proxy: proxyConfig ? proxyConfig.server : 'direct',
            });

            const response = await page.goto(url, {
              waitUntil: options.waitUntil || 'domcontentloaded',
              timeout,
            });

            // Optional post-navigation delay (for JS-heavy pages like Amazon)
            if (options.postNavDelay) {
              await new Promise(r => setTimeout(r, options.postNavDelay));
            }

            const domLoadedMs = Date.now() - t0;
            logger.info(`[TIMING] DOM loaded in ${domLoadedMs}ms`);

            // ── Early block detection via HTTP status ─────────────────
            const status = response?.status() || 200;
            let challengeHandled = false; // Track if we already resolved an Akamai challenge

            // HTTP 202 from Amazon is normal (accepted) — NOT a block
            if (status === 403 || status === 429 || status === 503) {
              // For Meesho, Akamai may send 403 with a solvable JS challenge.
              // Give the challenge time to resolve before marking as blocked.
              const challengeMs = options.challengeWaitMs || 0;
              if (challengeMs > 0 && platform === 'MEESHO') {
                logger.info(`[BROWSER] HTTP ${status} — waiting ${challengeMs}ms for Akamai challenge...`);
                try {
                  await page.waitForFunction(
                    () => {
                      const body = document.body?.innerText || '';
                      if (/₹[\d,]+/.test(body)) return true;
                      const h1 = document.querySelector('h1');
                      if (h1) {
                        const h1Text = h1.textContent?.trim().toLowerCase() || '';
                        if (h1Text.length > 5 && !/(access denied|error|blocked|forbidden)/i.test(h1Text)) return true;
                      }
                      return false;
                    },
                    { timeout: challengeMs }
                  );
                  logger.info(`[BROWSER] Akamai challenge resolved — product content detected`);
                  challengeHandled = true;
                } catch {
                  logger.error(`[BLOCKED] HTTP ${status} — Akamai hard block (Access Denied)`);
                  if (proxyRaw) proxyManager.markBlocked(proxyRaw);
                  throw new BlockedPageError(url, { antiBot: 'akamai', httpStatus: status });
                }
              } else if (platform === 'FLIPKART' && status === 403) {
                // Flipkart 403 — wait for JS challenge resolution
                logger.info(`[BROWSER] Flipkart HTTP 403 — waiting 5s for JS challenge...`);
                await new Promise(r => setTimeout(r, 5000));
                const bodyText = await page.evaluate(() => document.body?.innerText || '');
                if (/₹[\d,]+/.test(bodyText) || /add to cart/i.test(bodyText)) {
                  logger.info('[BROWSER] Flipkart 403 resolved — product content detected');
                  challengeHandled = true;
                } else {
                  logger.error(`[BLOCKED] Flipkart HTTP 403 — hard block`);
                  if (proxyRaw) proxyManager.markBlocked(proxyRaw);
                  throw new BlockedPageError(url, { antiBot: 'flipkart', httpStatus: status });
                }
              } else {
                logger.error(`[BLOCKED] HTTP ${status} — blocked at network level`);
                if (proxyRaw) proxyManager.markBlocked(proxyRaw);
                const antiBot = url.includes('meesho') ? 'akamai' : 'unknown';
                throw new BlockedPageError(url, { antiBot, httpStatus: status });
              }
            }

            // ── Wait for critical content selector ──────────────────
            if (options.waitForSelector) {
              try {
                await page.waitForSelector(options.waitForSelector, {
                  timeout: options.selectorTimeout || 12000,
                });
                logger.info(`[BROWSER] Selector found: ${options.waitForSelector}`);
              } catch {
                logger.warn(`[BROWSER] waitForSelector timed out: ${options.waitForSelector}`);
              }
            }

            // ── SPA content-ready wait (for Flipkart-style React hydration) ──
            if (options.waitForContentReady) {
              try {
                await page.waitForFunction(
                  () => {
                    const body = document.body?.innerText || '';
                    // Product content is ready when we see a ₹ price or a product title h1
                    return /₹[\d,]+/.test(body) || document.querySelector('h1')?.textContent?.length > 10;
                  },
                  { timeout: options.selectorTimeout || 8000 }
                );
                logger.info('[BROWSER] Content-ready: product data detected in body');
              } catch {
                logger.warn('[BROWSER] Content-ready wait timed out — proceeding with available HTML');
              }
            }

            // ── Human-like behavior simulation ───────────────────────
            if (options.humanSimulation) {
              await this._simulateHumanBehavior(page);
            }

            // ── Bot-protection challenge detection (skip if we already handled 403) ──
            if (!challengeHandled && options.challengeWaitMs && options.challengeWaitMs > 0) {
              const isBlocked = await this._isBlockedPage(page);
              if (isBlocked) {
                logger.warn('Detected bot-protection challenge page, waiting for resolution…');
                const resolved = await this._waitForChallengeResolution(
                  page,
                  options.challengeWaitMs
                );
                if (!resolved) {
                  if (proxyRaw) proxyManager.markBlocked(proxyRaw);
                  const antiBot = url.includes('meesho') ? 'akamai' : 'unknown';
                  throw new BlockedPageError(url, { antiBot });
                }
              }
            }

            // ── Final blocked-page check (skip if challenge was already resolved) ──
            if (!challengeHandled) {
              let blocked = await this._isBlockedPage(page);
              if (blocked) {
                // Try Amazon CAPTCHA bypass before giving up
                if (url.includes('amazon')) {
                  const bypassed = await this._tryAmazonCaptchaBypass(page, url);
                  if (bypassed) {
                    blocked = false; // Continue to extract HTML
                  }
                }
                if (blocked) {
                  logger.error('[BLOCKED] Blocked page detected after load');
                  if (proxyRaw) proxyManager.markBlocked(proxyRaw);
                  const antiBot = url.includes('meesho') ? 'akamai' : url.includes('amazon') ? 'amazon-captcha' : 'unknown';
                  throw new BlockedPageError(url, { antiBot });
                }
              }
            }

            const html = await page.content();
            const totalMs = Date.now() - t0;

            // Mark proxy as successful
            if (proxyRaw) proxyManager.markSuccess(proxyRaw, totalMs);

            logger.info(`[TIMING] Scrape completed in ${totalMs}ms`);

            return html;
          } catch (error) {
            if (proxyRaw && !(error instanceof BlockedPageError)) {
              proxyManager.markFailed(proxyRaw);
            }
            throw error;
          } finally {
            if (context) await context.close();
          }
        },
        {
          maxRetries: options.maxRetries || config.maxRetries,
          backoffBase: config.backoffBase,
        }
      );
    } catch (error) {
      if (error instanceof ScraperTimeoutError) throw error;
      if (error instanceof BlockedPageError) throw error;
      // Only wrap as timeout if it's actually a Playwright timeout
      if (error.message && error.message.includes('Timeout')) {
        throw new ScraperTimeoutError(url);
      }
      // Preserve original error class (ParseError, AppError, etc.)
      throw error;
    }
  }

  /**
   * Detect whether the current page is a bot-protection challenge or block page.
   * Checks for Akamai, Cloudflare, Amazon robot-check, and generic patterns.
   */
  async _isBlockedPage(page) {
    return page.evaluate((patterns) => {
      const title = (document.title || '').toLowerCase();
      const bodyText = document.body ? document.body.innerText.substring(0, 1000) : '';
      const combinedText = title + ' ' + bodyText;

      // Check all blocked-page patterns against visible text
      for (const patternStr of patterns) {
        const regex = new RegExp(patternStr, 'i');
        if (regex.test(combinedText)) return true;
      }

      // Check the full HTML for Amazon CAPTCHA indicators
      const html = document.documentElement.innerHTML || '';
      if (/opfcaptcha/i.test(html)) return true;
      if (/validateCaptcha/i.test(html)) return true;

      // Structural checks — Akamai / Cloudflare challenge elements
      if (document.querySelector('.scf-akamai-logo-sec-abc')) return true;
      if (document.querySelector('[class*="akamai"]')) return true;
      if (document.querySelector('#challenge-running')) return true;
      if (document.querySelector('#challenge-form')) return true;

      // Amazon CAPTCHA form check
      if (document.querySelector('form[action*="validateCaptcha"]')) return true;

      return false;
    }, BLOCKED_PAGE_PATTERNS.map((r) => r.source));
  }

  /**
   * Try to bypass Amazon's "Continue shopping" CAPTCHA page by clicking the button.
   * After CAPTCHA submission, Amazon typically redirects to the homepage — 
   * so we must re-navigate back to the original product URL.
   * Returns true if bypass succeeded (page has product content), false otherwise.
   */
  async _tryAmazonCaptchaBypass(page, originalUrl) {
    try {
      const hasForm = await page.evaluate(() => {
        return !!document.querySelector('form[action*="validateCaptcha"]');
      });
      if (!hasForm) return false;

      logger.info('[BROWSER] Attempting Amazon CAPTCHA bypass (clicking Continue shopping)');

      // Click the submit button
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) { btn.click(); return true; }
        const form = document.querySelector('form[action*="validateCaptcha"]');
        if (form) { form.submit(); return true; }
        return false;
      });

      if (!clicked) return false;

      // Wait for navigation after CAPTCHA submit
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));

      // Check if we're still on the CAPTCHA page
      const stillBlocked = await this._isBlockedPage(page);
      if (stillBlocked) {
        logger.warn('[BROWSER] Amazon CAPTCHA bypass failed — still on challenge page');
        return false;
      }

      // CAPTCHA resolved! But Amazon usually redirects to homepage, not the product.
      // Check if we have product content; if not, re-navigate to the original URL.
      const hasProduct = await page.evaluate(() => {
        return !!document.querySelector('#productTitle, #dp-container, #title_feature_div');
      });

      if (!hasProduct && originalUrl) {
        logger.info('[BROWSER] CAPTCHA bypassed — re-navigating to product URL');
        await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));
        
        // Check if we got blocked again on re-navigation
        const blockedAgain = await this._isBlockedPage(page);
        if (blockedAgain) {
          logger.warn('[BROWSER] Re-navigation after CAPTCHA bypass got blocked again');
          return false;
        }
      }

      logger.info('[BROWSER] Amazon CAPTCHA bypass succeeded!');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Poll until the challenge page is replaced by real content.
   * Returns true if resolved, false if timed out.
   */
  async _waitForChallengeResolution(page, maxWaitMs) {
    const pollInterval = 2000;
    const maxPolls = Math.ceil(maxWaitMs / pollInterval);

    for (let i = 0; i < maxPolls; i++) {
      await page.waitForTimeout(pollInterval);
      const stillBlocked = await this._isBlockedPage(page);
      if (!stillBlocked) {
        logger.info('Bot-protection challenge resolved successfully');
        return true;
      }
      logger.info(`Challenge poll ${i + 1}/${maxPolls}: still blocked`);
    }

    logger.warn(`Bot-protection challenge did not resolve within ${maxWaitMs}ms`);
    return false;
  }

  /**
   * Simulate minimal human-like behavior after page load.
   * Performs 2-3 small scrolls with random pauses.
   * Goal: trigger Akamai's delayed JS checks to see "user" interaction.
   */
  async _simulateHumanBehavior(page) {
    try {
      // Random initial delay: 1.5-3 seconds
      const initialDelay = 1500 + Math.floor(Math.random() * 1500);
      await page.waitForTimeout(initialDelay);

      // Small scroll down (200-400px)
      await page.evaluate(() => window.scrollBy(0, 200 + Math.floor(Math.random() * 200)));
      await page.waitForTimeout(500 + Math.floor(Math.random() * 500));

      // Scroll a bit more (100-300px)
      await page.evaluate(() => window.scrollBy(0, 100 + Math.floor(Math.random() * 200)));
      await page.waitForTimeout(400 + Math.floor(Math.random() * 400));

      // Scroll back slightly (50-100px)
      await page.evaluate(() => window.scrollBy(0, -(50 + Math.floor(Math.random() * 50))));

      logger.info('[BROWSER] Scroll simulation done');
    } catch {
      // Non-critical — page may have navigated away
    }
  }

  /** Graceful shutdown. */
  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('Browser closed');
    }
  }
}

// Singleton
module.exports = new BrowserManager();
