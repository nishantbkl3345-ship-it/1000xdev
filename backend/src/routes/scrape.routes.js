const { Router } = require('express');
const { z } = require('zod');
const validateRequest = require('../middlewares/validate.request');
const scrapeController = require('../controllers/scrape.controller');

const router = Router();

/** Zod schema for scrape request body. */
const scrapeSchema = z.object({
  url: z
    .string({ required_error: 'URL is required' })
    .url('Must be a valid URL')
    .refine(
      (val) => val.startsWith('http://') || val.startsWith('https://'),
      { message: 'URL must start with http:// or https://' }
    ),
});

router.post('/', validateRequest(scrapeSchema), (req, res, next) => {
  scrapeController.handle(req, res, next);
});

module.exports = router;
