const logger = require('./logger');

/**
 * Retry wrapper with exponential backoff.
 *
 * @param {Function} fn        — async function to retry
 * @param {Object}   options
 * @param {number}   options.maxRetries  — max attempts (default: 3)
 * @param {number}   options.backoffBase — base delay in ms (default: 1000)
 * @param {Function} options.onRetry     — callback(error, attempt) before each retry
 * @returns {Promise<*>} — result of fn()
 */
async function retry(fn, options = {}) {
  const { maxRetries = 3, backoffBase = 1000, onRetry } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt === maxRetries) {
        logger.error(`All ${maxRetries} retry attempts exhausted`, {
          error: error.message,
        });
        throw error;
      }

      const delay = backoffBase * Math.pow(2, attempt - 1);
      logger.warn(`Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`, {
        error: error.message,
      });

      if (onRetry) onRetry(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = { retry };
