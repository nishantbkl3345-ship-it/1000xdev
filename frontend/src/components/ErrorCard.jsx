import './ErrorCard.css';

const ERROR_MAP = {
  VALIDATION_ERROR: { title: 'Invalid Input', hint: 'Check the URL format and try again.' },
  UNSUPPORTED_PLATFORM: { title: 'Unsupported Platform', hint: 'Only Amazon, Flipkart, and Meesho are supported.' },
  SCRAPE_TIMEOUT: { title: 'Scrape Timed Out', hint: 'The page took too long to load. Try again later.' },
  PARSE_ERROR: { title: 'Parsing Failed', hint: 'Could not extract data from the page. The layout may have changed.' },
  NETWORK_ERROR: { title: 'Network Error', hint: 'Could not connect to the server. Check your connection.' },
  INTERNAL_ERROR: { title: 'Server Error', hint: 'Something went wrong on our end. Please try again.' },
};

export default function ErrorCard({ error, onDismiss }) {
  if (!error) return null;

  const mapped = ERROR_MAP[error.code] || {
    title: 'Something went wrong',
    hint: error.message || 'An unexpected error occurred.',
  };

  return (
    <div className="error-card">
      <div className="error-card__icon">✕</div>
      <div className="error-card__body">
        <h3 className="error-card__title">{mapped.title}</h3>
        <p className="error-card__hint">{mapped.hint}</p>
        {error.message && error.message !== mapped.hint && (
          <p className="error-card__detail">{error.message}</p>
        )}
      </div>
      <button className="error-card__dismiss" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
