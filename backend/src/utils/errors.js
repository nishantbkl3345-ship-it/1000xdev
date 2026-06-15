/**
 * Custom error classes — mapped to HTTP status codes in error.handler.js.
 */

class AppError extends Error {
  constructor(message, statusCode, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, 400, 'INVALID_URL', details);
  }
}

class UnsupportedPlatformError extends AppError {
  constructor(hostname) {
    super(
      'URL does not belong to a supported platform (Amazon, Flipkart, Meesho).',
      422,
      'UNSUPPORTED_PLATFORM',
      { hostname }
    );
  }
}

class ScraperTimeoutError extends AppError {
  constructor(url) {
    super(
      'Scraping timed out after maximum retries.',
      504,
      'SCRAPE_TIMEOUT',
      { url }
    );
  }
}

class ParseError extends AppError {
  constructor(message, details = {}) {
    super(message, 500, 'PARSE_ERROR', details);
  }
}

class BlockedPageError extends AppError {
  constructor(url, details = {}) {
    super(
      'Request was blocked by anti-bot protection. Retrying with a different proxy.',
      403,
      'BLOCKED_PAGE',
      {
        url,
        blocked: true,
        antiBot: details.antiBot || 'unknown',
        extractionStatus: 'blocked_by_protection',
        ...details,
      }
    );
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnsupportedPlatformError,
  ScraperTimeoutError,
  ParseError,
  BlockedPageError,
};
