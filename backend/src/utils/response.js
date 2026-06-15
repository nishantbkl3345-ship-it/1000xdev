/**
 * Standardized response helpers — pure functions, no class.
 */

function successResponse(data, warnings = [], meta = {}) {
  return {
    success: true,
    data,
    meta: {
      scrapedAt: new Date().toISOString(),
      durationMs: meta.durationMs || null,
      warnings,
    },
  };
}

function errorResponse(code, message, details = {}, meta = {}) {
  return {
    success: false,
    data: null,
    error: { code, message, details },
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  };
}

module.exports = { successResponse, errorResponse };
