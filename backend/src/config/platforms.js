/**
 * Platform enum and hostname → platform mapping.
 */
const Platform = Object.freeze({
  AMAZON: 'AMAZON',
  FLIPKART: 'FLIPKART',
  MEESHO: 'MEESHO',
});

/**
 * Maps known hostnames to their platform.
 * Supports www and non-www variants.
 */
const HOSTNAME_MAP = new Map([
  ['www.amazon.in', Platform.AMAZON],
  ['amazon.in', Platform.AMAZON],
  ['www.amazon.com', Platform.AMAZON],
  ['amazon.com', Platform.AMAZON],
  ['www.flipkart.com', Platform.FLIPKART],
  ['flipkart.com', Platform.FLIPKART],
  ['www.meesho.com', Platform.MEESHO],
  ['meesho.com', Platform.MEESHO],
]);

module.exports = { Platform, HOSTNAME_MAP };
