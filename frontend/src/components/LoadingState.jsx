import './LoadingState.css';

export default function LoadingState() {
  return (
    <div className="loading-state">
      <div className="loading-state__spinner" />
      <p className="loading-state__text">Scraping product data…</p>
      <p className="loading-state__sub">This may take 15–30 seconds depending on the page.</p>
    </div>
  );
}
