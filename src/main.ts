import { PlaywrightCrawler, type PlaywrightCrawlingContext } from '@crawlee/playwright';
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

/**
 * Resolve a Flipkart `dl.flipkart.com/s/…` short/deep link to its canonical
 * product URL (`www.flipkart.com/…/p/…?pid=…`) BEFORE Playwright navigates.
 *
 * Diagnosed root cause (run d0lGJ8DU98fTvb9OO): navigating the short link
 * in-browser under headless + Apify proxy is the fragile step that stalls on
 * `domcontentloaded`; the canonical PDP itself loads fast. We resolve the
 * (HTTP-level) redirect via the page's OWN APIRequestContext so the request
 * carries the SAME proxy / session / browser headers as the crawl — a bare HTTP
 * client is 403'd by Flipkart. Returns the canonical URL only when it validates
 * as a real PDP; otherwise null → caller keeps the original URL (safe fallback).
 */
async function resolveFlipkartShortUrl(
    page: PlaywrightCrawlingContext['page'],
    shortUrl: string,
): Promise<string | null> {
    // Flipkart 403s non-browser HTTP clients (verified: the default request-API
    // User-Agent is blocked; a real Chrome UA is accepted). Forward the browser's
    // OWN navigator.userAgent + standard document Accept headers so the redirect
    // probe looks identical to the navigation that follows. The APIRequestContext
    // still shares the browser context's proxy/session; body is followed through
    // the HTTP redirect chain and resp.url() is the final canonical URL.
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const resp = await page.context().request.get(shortUrl, {
        timeout: 15_000,
        headers: {
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });
    const canonical = resp.url();
    const isPdp =
        /:\/\/(www\.)?flipkart\.com\//i.test(canonical) &&
        canonical.includes('/p/') &&
        /[?&]pid=/i.test(canonical);
    return isPdp ? canonical : null;
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
        async ({ request, page }, gotoOptions) => {
            if (request.label !== 'flipkart') return;
            if (gotoOptions) {
                gotoOptions.waitUntil = 'domcontentloaded';
            }

            // Pre-resolve dl.flipkart.com short/deep links to the canonical PDP
            // so Playwright navigates straight to the product page instead of
            // running the fragile in-browser short-link redirect. On any failure
            // we leave request.url untouched → existing navigation behavior.
            if (/dl\.flipkart\.com\/s\//i.test(request.url)) {
                log.info('[FlipkartResolver] short URL detected');
                try {
                    const canonical = await resolveFlipkartShortUrl(page, request.url);
                    if (canonical) {
                        log.info('[FlipkartResolver] canonical URL resolved');
                        log.info('[FlipkartResolver] canonical PDP validation: PASS');
                        request.url = canonical;
                    } else {
                        log.warning('[FlipkartResolver] canonical resolution failed');
                        log.info('[FlipkartResolver] fallback to existing navigation');
                    }
                } catch {
                    log.warning('[FlipkartResolver] canonical resolution failed');
                    log.info('[FlipkartResolver] fallback to existing navigation');
                }
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
