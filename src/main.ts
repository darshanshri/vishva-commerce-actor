import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';

import { router } from './router.js';
import { detectMerchant } from './utils.js';

interface StartUrl {
    url: string;
    method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'OPTIONS' | 'CONNECT' | 'PATCH';
    headers?: Record<string, string>;
    userData?: Record<string, unknown>;
}

interface Input {
    startUrls: StartUrl[];
    maxRequestsPerCrawl?: number;
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? { startUrls: [] };
const { startUrls = [], maxRequestsPerCrawl = 10 } = input;

// checkAccess: true is omitted. It added ~2–5 s of overhead per run
// (Apify validates the proxy by fetching an external endpoint before
// the first request). The proxy still works without this check; the
// overhead is pure wait time with no correctness benefit.
const proxyConfiguration = await Actor.createProxyConfiguration();

// Label each request with its detected merchant so the router can
// dispatch to the correct per-merchant handler without examining the
// URL again inside the handler.
const labeledStartUrls = startUrls.map((r) => {
    const merchant = detectMerchant(r.url);
    return {
        ...r,
        label: merchant,
        userData: { ...r.userData, merchant },
    };
});

// TEMPORARY routing diagnostics (Phase 1 live validation).
// Prints the enqueue-time decision for every start URL so the Apify run
// log shows: original URL → detected merchant → assigned label. Keep until
// routing is confirmed on all four merchants, then remove.
for (const r of labeledStartUrls) {
    log.info(`[ROUTE] original URL: ${r.url}`);
    log.info(`[ROUTE] detected merchant: ${r.userData.merchant}`);
    log.info(`[ROUTE] assigned label: ${r.label}`);
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    requestHandler: router,
    // Flipkart PDPs (reached via the dl.flipkart.com short-URL redirect) keep
    // trackers/ads/long-poll connections open and never fire the `load` event
    // inside the 60 s navigation timeout, so the default waitUntil:'load' wastes
    // a full attempt. Switch ONLY Flipkart to 'domcontentloaded'; the handler
    // already re-waits domcontentloaded + waitForSelector('h1'), so readiness is
    // preserved. Amazon/Myntra/Nykaa keep their existing 'load' navigation.
    preNavigationHooks: [
        async ({ request }, gotoOptions) => {
            if (request.label === 'flipkart' && gotoOptions) {
                gotoOptions.waitUntil = 'domcontentloaded';
            }
        },
    ],
    // Explicit safety bounds so one pathological request can never consume the
    // whole 300 s Actor run: 3 attempts × (45 s nav + 45 s handler) = 270 s hard
    // ceiling < 300 s. Normal Flipkart extraction finishes in ~10–20 s, so these
    // leave ample room for the dynamic bank-offer/feature/spec passes.
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 45,
    maxRequestRetries: 2,
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
});

await crawler.run(labeledStartUrls);

await Actor.exit();
