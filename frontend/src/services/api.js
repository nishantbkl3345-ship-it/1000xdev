const API_BASE = '/api/v1';

/**
 * Call the scrape endpoint.
 * @param {string} url — product URL to scrape
 * @returns {Promise<object>} — parsed JSON response
 */
export async function scrapeProduct(url) {
  const res = await fetch(`${API_BASE}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  const data = await res.json();

  if (!res.ok || !data.success) {
    const err = new Error(data.error?.message || 'Scraping failed');
    err.code = data.error?.code || 'UNKNOWN_ERROR';
    err.details = data.error?.details || {};
    err.status = res.status;
    throw err;
  }

  return data;
}
