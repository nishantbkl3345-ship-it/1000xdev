import { useState } from 'react';
import './UrlInput.css';

const PLATFORM_HINTS = {
  'amazon': '🟠 Amazon',
  'flipkart': '🔵 Flipkart',
  'meesho': '🟣 Meesho',
};

function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const [key, label] of Object.entries(PLATFORM_HINTS)) {
      if (hostname.includes(key)) return label;
    }
  } catch {
    // invalid URL
  }
  return null;
}

export default function UrlInput({ onSubmit, isLoading }) {
  const [url, setUrl] = useState('');
  const platform = detectPlatform(url);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (url.trim() && !isLoading) {
      onSubmit(url.trim());
    }
  };

  return (
    <form className="url-input" onSubmit={handleSubmit}>
      <div className="url-input__wrapper">
        <input
          id="url-field"
          type="url"
          className="url-input__field"
          placeholder="Paste Amazon, Flipkart, or Meesho product URL..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={isLoading}
          autoFocus
        />
        {platform && <span className="url-input__badge">{platform}</span>}
      </div>
      <button
        id="scrape-btn"
        type="submit"
        className="url-input__btn"
        disabled={!url.trim() || isLoading}
      >
        {isLoading ? 'Scraping…' : 'Scrape'}
      </button>
    </form>
  );
}
