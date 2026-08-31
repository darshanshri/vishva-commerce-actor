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
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
});

await crawler.run(labeledStartUrls);

await Actor.exit();
