const logger = require('../utils/logger');
const { errorResponse } = require('../utils/response');
const { AppError } = require('../utils/errors');

/**
 * Global Express error handler — maps error class to HTTP status + response.
 */
function errorHandler(err, req, res, _next) {
  // Known application errors
  if (err instanceof AppError) {
    logger.error(`[${err.code}] ${err.message}`, { details: err.details });
    return res.status(err.statusCode).json(
      errorResponse(err.code, err.message, err.details)
    );
  }

  // Unknown / unexpected errors
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
  });

  return res.status(500).json(
    errorResponse('INTERNAL_ERROR', 'An unexpected error occurred.')
  );
}

module.exports = errorHandler;
