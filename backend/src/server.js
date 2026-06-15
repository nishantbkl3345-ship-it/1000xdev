const app = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const browserManager = require('./utils/browser.manager');

const PORT = config.port;

const server = app.listen(PORT, () => {
  logger.info(`Scraping microservice running on port ${PORT}`, {
    env: config.nodeEnv,
    proxies: config.proxies.length,
  });
});

// Graceful shutdown
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  await browserManager.cleanup();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason?.message || reason, stack: reason?.stack });
});

