// Central helpers for API responses and async wrapper
const logger = require('./logger');

function sendError(res, status = 500, message = 'Server error', detail) {
  // Always log the error server-side with detail when available
  try {
    logger.error('api.error.response', { status, message, detail });
  } catch (e) {
    // swallow logger errors
    console.error('apiResponses.logger_failed', e && e.message ? e.message : e);
  }

  const body = { error: message };

  // Only include a 'detail' field when not in production to avoid leaking internals
  if (detail && process.env.NODE_ENV !== 'production') {
    body.detail = typeof detail === 'string' ? detail : JSON.stringify(detail);
  }

  // Ensure we always return JSON and do not leak stacks
  try {
    return res.status(status).json(body);
  } catch (e) {
    // Fallback safety: if sending JSON fails, send minimal text
    try { return res.status(status).send(body.error); } catch (e2) { return res.end(); }
  }
}

function sendSuccess(res, payload = {}) {
  try {
    return res.json(payload);
  } catch (e) {
    // If JSON send fails, log and try a fallback
    logger.error('api.success.send_failed', { message: e && e.message ? e.message : String(e) });
    try { return res.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); } catch (e2) { return res.end(); }
  }
}

// Wrap async route handlers to forward errors to Express error middleware
function wrapAsync(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  sendError,
  sendSuccess,
  wrapAsync
};
