import { createPlaywrightRouter } from '@crawlee/playwright';
import { handleAmazon } from './merchants/amazon.js';
import { handleFliipkart } from './merchants/flipkart.js';
import { handleMyntra } from './merchants/myntra.js';
import { handleNykaa } from './merchants/nykaa.js';

/**
 * Central dispatch router.
 *
 * Each incoming request carries a `label` in `userData` set by main.ts
 * via detectMerchant(). The router forwards to the correct per-merchant
 * handler, which is responsible for all page interaction and pushData.
 *
 * main.ts sets the label; this file only routes.
 * Do NOT add merchant-specific logic here.
 */
export const router = createPlaywrightRouter();

router.addHandler('amazon', handleAmazon);
router.addHandler('flipkart', handleFliipkart);
router.addHandler('myntra', handleMyntra);
router.addHandler('nykaa', handleNykaa);

router.addDefaultHandler(async ({ request, log, pushData }) => {
    log.warning(
        `[router] Unknown merchant for URL: ${request.url} — no handler registered. Pushing minimal stub.`,
    );
    await pushData({
        merchant: 'unknown',
        productId: null,
        title: null,
        brand: null,
        price: null,
        priceText: null,
        mrp: null,
        mrpText: null,
        rating: null,
        reviewCount: null,
        availability: null,
        seller: null,
        features: [],
        specifications: {},
        variants: [],
        images: [],
        offers: [],
        url: request.url,
        scrapedAt: new Date().toISOString(),
    });
});
