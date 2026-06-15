const logger = require('../utils/logger');

/**
 * Request logger middleware — logs method, path, status code, and duration.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'error' : 'info';

    logger[level](`${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`);
  });

  next();
}

module.exports = requestLogger;
