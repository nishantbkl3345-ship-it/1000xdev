import './WarningsBanner.css';

export default function WarningsBanner({ warnings }) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <div className="warnings-banner">
      <span className="warnings-banner__icon">⚠</span>
      <div className="warnings-banner__body">
        <strong>Partial extraction</strong> — some fields could not be scraped:
        <ul className="warnings-banner__list">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
