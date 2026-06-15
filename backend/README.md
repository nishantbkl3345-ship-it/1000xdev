# Scraping Microservice

A production-quality scraping microservice for extracting structured product data and offers from **Amazon**, **Flipkart**, and **Meesho**.

## Tech Stack

- **Runtime**: Node.js + Express
- **Browser Automation**: Playwright (Chromium)
- **HTML Parsing**: Cheerio
- **Validation**: Zod
- **Logging**: Winston
- **Config**: dotenv

## Architecture

- **Layered architecture** — Middleware → Controller → Service → Scraper
- **Strategy pattern** — each platform has its own modular scraper
- **Singleton browser** — one Playwright instance, fresh context per request
- **Partial success** — returns available data even if some fields fail to parse

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browser
npx playwright install chromium

# 3. Configure environment
cp .env.example .env
# Edit .env with your proxy settings (optional)

# 4. Start server
npm start

# Or with auto-restart on changes:
npm run dev
```

## API

### `POST /api/v1/scrape`

**Request:**
```json
{
  "url": "https://www.amazon.in/dp/B0EXAMPLE"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "platform": "AMAZON",
    "url": "https://www.amazon.in/dp/B0EXAMPLE",
    "product": {
      "title": "Product Name",
      "price": 1299,
      "mrp": 1999,
      "currency": "INR",
      "discount": "35% off",
      "rating": 4.3,
      "reviewCount": 12453,
      "seller": "Seller Name",
      "availability": "In Stock",
      "images": ["https://..."]
    },
    "offers": {
      "bankOffers": [],
      "emiOffers": [],
      "coupons": [],
      "exchangeOffers": [],
      "deliveryOffers": [],
      "otherOffers": []
    }
  },
  "meta": {
    "scrapedAt": "2026-06-13T01:00:00.000Z",
    "durationMs": 2340,
    "warnings": []
  }
}
```

**Error Response (400/422/500/504):**
```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "UNSUPPORTED_PLATFORM",
    "message": "URL does not belong to a supported platform.",
    "details": { "hostname": "www.snapdeal.com" }
  },
  "meta": {
    "timestamp": "2026-06-13T01:00:00.000Z"
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid request body or URL format |
| `UNSUPPORTED_PLATFORM` | 422 | URL is not Amazon, Flipkart, or Meesho |
| `SCRAPE_TIMEOUT` | 504 | Page failed to load after 3 retries |
| `PARSE_ERROR` | 500 | Page loaded but parsing failed entirely |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### `GET /health`

Returns `{ "status": "ok" }` — use for uptime monitoring.

## Supported Platforms

| Platform | Domains |
|----------|---------|
| Amazon | `amazon.in`, `amazon.com` |
| Flipkart | `flipkart.com` |
| Meesho | `meesho.com` |

## Proxy Configuration

Add proxies in `.env` using numbered keys:

```env
PROXY_1=http://user:pass@proxy-us.example.com:8080
PROXY_2=http://user:pass@proxy-eu.example.com:8080
```

Proxies are selected randomly per request. Failed proxies enter a 60-second cooldown.

## Project Structure

```
src/
├── app.js                  # Express app factory
├── server.js               # HTTP server + graceful shutdown
├── config/                 # Environment, constants, platform definitions
├── routes/                 # API route definitions
├── controllers/            # Thin request handlers
├── services/               # Business logic orchestration
├── scrapers/               # Platform-specific scrapers (Strategy Pattern)
├── utils/                  # Logger, retry, proxy, browser, response helpers
└── middlewares/            # Validation, error handling, request logging
```
