const express = require('express');
const requestLogger = require('./middlewares/request.logger');
const errorHandler = require('./middlewares/error.handler');
const scrapeRoutes = require('./routes/scrape.routes');

/**
 * Express app factory — mounts middleware and routes.
 */
const app = express();

// Body parsing
app.use(express.json());

// Request logging
app.use(requestLogger);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1/scrape', scrapeRoutes);

// Global error handler (must be last)
app.use(errorHandler);

module.exports = app;
