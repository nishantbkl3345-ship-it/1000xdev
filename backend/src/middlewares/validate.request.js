const { ZodError } = require('zod');
const { errorResponse } = require('../utils/response');

/**
 * Zod validation middleware factory.
 *
 * @param {import('zod').ZodSchema} schema — Zod schema to validate req.body against
 * @returns {Function} Express middleware
 */
function validateRequest(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));

        return res.status(400).json(
          errorResponse('VALIDATION_ERROR', 'Request validation failed.', { errors: details })
        );
      }
      next(error);
    }
  };
}

module.exports = validateRequest;
