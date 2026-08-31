import type { MerchantId } from './types.js';

/**
 * Detect the target merchant from a product URL.
 * Used in main.ts to label each request so the router dispatches
 * to the correct per-merchant handler.
 */
export function detectMerchant(url: string): MerchantId {
    if (/amazon\.(in|com)/i.test(url)) return 'amazon';
    if (/flipkart\.com/i.test(url)) return 'flipkart';
    if (/myntra\.com/i.test(url)) return 'myntra';
    // Matches both nykaa.com (beauty) and nykaafashion.com (fashion);
    // per Phase 1 mapping, both route to the nykaa handler.
    if (/nykaa(?:fashion)?\.com/i.test(url)) return 'nykaa';
    return 'unknown';
}

/**
 * True when SCRAPER_DEBUG=1 is set in the environment.
 * Gates expensive diagnostics (screenshots, full body serialization) that add
 * ~1.5 s per run. Enable locally; never set in production.
 */
export function isDebugMode(): boolean {
    return process.env['SCRAPER_DEBUG'] === '1';
}
