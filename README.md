# E-Commerce Product Scraper (Full-Stack)

A production-grade, full-stack web application designed to bypass anti-bot systems (Akamai, Cloudflare, Amazon CAPTCHAs) and extract structured product details, pricing, delivery information, offers, and variants from **Amazon India**, **Flipkart**, and **Meesho**.

---

## 🚀 Key Features

*   **Stealth Browser Automation**: Uses Playwright with stealth evasions, randomized user agents, and custom canvas/webgl fingerprinters to bypass anti-bot frameworks.
*   **Smart Proxy Rotation**: Uses a weighted scoring proxy manager that tracks success rates, response times, and dynamically cooldowns/demotes bad proxies.
*   **Direct Fallback Logic**: If all configured proxies fail, the scraper automatically falls back to a direct connection on the final attempt.
*   **Amazon CAPTCHA Bypass**: Detects and programmatically solves Amazon's CAPTCHA challenge pages, and automatically re-navigates back to the target product URL.
*   **Resilient DOM/JSON-LD Scrapers**: Custom scrapers targeting JSON-LD structured data first, falling back to robust, scoped DOM selectors.
*   **Interactive React Frontend**: Premium UI with beautiful state management, detailed offer cards, variant selectors, and live websocket-like log streamers.

---

## 📁 Repository Structure

```
├── backend/                  # Node.js + Express + Playwright Scraper microservice
│   ├── src/
│   │   ├── config/           # Constants and platform configs
│   │   ├── controllers/      # Slim controller layer
│   │   ├── scrapers/         # Strategy pattern scrapers (Amazon, Flipkart, Meesho)
│   │   ├── services/         # Scrape orchestration
│   │   └── utils/            # Proxy manager, browser manager, logger, user-agents
├── frontend/                 # React + Vite + CSS Variables (Clean UI)
│   ├── src/
│   │   ├── components/       # ProductCard, WarningsBanner, UrlInput, LogsPanel
│   │   └── App.jsx           # Main page layout and orchestration
└── README.md                 # This file
```

---

## 🛠️ Getting Started

### Prerequisites

Ensure you have [Node.js](https://nodejs.org/) (v18 or higher) installed.

### 1. Setup Backend

Navigate to the `backend` directory, install dependencies, and set up your environment:

```bash
cd backend
npm install

# Install Playwright browser dependencies
npx playwright install chromium
```

Create a `.env` file in the `backend/` folder:

```env
PORT=3000
NODE_ENV=development

# List your proxies (randomly rotated, with cooldown on block)
PROXY_1=http://username:password@ip:port
PROXY_2=http://username:password@ip:port
# Add up to PROXY_10 or more...
```

Start the backend:

```bash
npm run dev
```

The backend API will run on `http://localhost:3000`.

### 2. Setup Frontend

Navigate to the `frontend` directory and install dependencies:

```bash
cd ../frontend
npm install
```

Start the development server:

```bash
npm run dev
```

The frontend will run on `http://localhost:5173`.

---

## 🔌 API Documentation

### `POST /api/v1/scrape`

Scrapes product details from a given URL.

*   **URL**: `/api/v1/scrape`
*   **Method**: `POST`
*   **Headers**: `Content-Type: application/json`
*   **Payload**:

```json
{
  "url": "https://www.amazon.in/dp/B0D3DH8TSC"
}
```

*   **Response (200 OK)**:

```json
{
  "success": true,
  "data": {
    "platform": "AMAZON",
    "url": "https://www.amazon.in/dp/B0D3DH8TSC",
    "product": {
      "title": "Product Title",
      "price": 1299,
      "mrp": 6490,
      "currency": "INR",
      "discount": "-80%",
      "rating": 4,
      "reviewCount": 10012,
      "seller": "Retail Pvt Ltd",
      "availability": "In stock",
      "images": ["https://..."]
    },
    "offers": {
      "bankOffers": [],
      "exchangeOffers": []
    }
  }
}
```

---

## 🛡️ Anti-Blocking Architecture

1.  **DOM Content Loaded Wait**: Avoids standard `networkidle` timeouts on heavily JS-hydrated sites by waiting for primary content containers and then pausing 3 seconds for React hydration.
2.  **Challenge Pages (403/Akamai)**: Explicitly waits 5 seconds for inline Akamai JS challenges to complete before registering a block.
3.  **Clean DOM Strategy**: Discards sponsored ads and promotional blocks during scraping to avoid noisy extraction results.
