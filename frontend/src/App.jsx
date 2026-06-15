import { useState, useCallback } from 'react';
import UrlInput from './components/UrlInput';
import ProductCard from './components/ProductCard';
import OffersPanel from './components/OffersPanel';
import LogsPanel from './components/LogsPanel';
import ErrorCard from './components/ErrorCard';
import LoadingState from './components/LoadingState';
import WarningsBanner from './components/WarningsBanner';
import { scrapeProduct } from './services/api';
import './App.css';

function timestamp() {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function detectPlatformName(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('amazon')) return 'Amazon';
    if (host.includes('flipkart')) return 'Flipkart';
    if (host.includes('meesho')) return 'Meesho';
  } catch {
    // ignore
  }
  return 'Unknown';
}

export default function App() {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]);

  const addLog = useCallback((level, message) => {
    setLogs((prev) => [...prev, { level, message, time: timestamp() }]);
  }, []);

  const handleScrape = useCallback(
    async (url) => {
      // Reset state
      setResult(null);
      setError(null);
      setLogs([]);
      setIsLoading(true);

      const platform = detectPlatformName(url);

      addLog('INFO', `Platform detected: ${platform}`);
      addLog('INFO', 'Sending scrape request…');

      try {
        addLog('INFO', 'Waiting for server response…');

        const data = await scrapeProduct(url);

        addLog('SUCCESS', `Scraping completed in ${data.meta?.durationMs || '?'}ms`);

        // Log warnings
        if (data.meta?.warnings?.length > 0) {
          data.meta.warnings.forEach((w) => addLog('WARNING', w));
        }

        setResult(data);
      } catch (err) {
        addLog('ERROR', err.message || 'Scraping failed');

        // Distinguish network failures from API errors
        if (!err.code) {
          setError({
            code: 'NETWORK_ERROR',
            message: 'Could not reach the server. Is the backend running?',
          });
        } else {
          setError(err);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [addLog]
  );

  return (
    <div className="app">
      {/* Header */}
      <header className="app__header">
        <h1 className="app__logo">
          <span className="app__logo-icon">⚡</span> Scraper
        </h1>
        <p className="app__tagline">Extract product data from Amazon, Flipkart &amp; Meesho</p>
      </header>

      {/* Input */}
      <section className="app__input-section">
        <UrlInput onSubmit={handleScrape} isLoading={isLoading} />
      </section>

      {/* Loading */}
      {isLoading && <LoadingState />}

      {/* Error */}
      {error && <ErrorCard error={error} onDismiss={() => setError(null)} />}

      {/* Results */}
      {result && (
        <section className="app__results">
          {/* Warnings */}
          <WarningsBanner warnings={result.meta?.warnings} />

          {/* Duration badge */}
          {result.meta?.durationMs && (
            <p className="app__duration">
              Scraped in <strong>{(result.meta.durationMs / 1000).toFixed(1)}s</strong>
            </p>
          )}

          {/* Product */}
          <ProductCard
            product={result.data?.product}
            platform={result.data?.platform}
            variants={result.data?.variants}
          />

          {/* Offers */}
          <OffersPanel offers={result.data?.offers} />
        </section>
      )}

      {/* Logs — always show when populated */}
      <LogsPanel logs={logs} />
    </div>
  );
}
