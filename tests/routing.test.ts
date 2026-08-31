import { describe, it, expect } from 'vitest';

// Import the COMPILED artifacts (dist/) — this is exactly the code that
// ships in the Docker image (`node dist/main.js`). Testing dist rather
// than src guarantees we prove the shipped behavior, not a TS-only view.
import { detectMerchant } from '../dist/utils.js';
import { router } from '../dist/router.js';

/**
 * The four real Phase 1 PDP URLs and the merchant each MUST route to.
 * These are the exact URLs used in the Apify live-validation runs.
 */
const CASES = [
    { name: 'Amazon', url: 'https://www.amazon.in/dp/B0H6WWPNYX', merchant: 'amazon' },
    { name: 'Flipkart (short/redirect)', url: 'https://dl.flipkart.com/s/YFcyGZNNNN', merchant: 'flipkart' },
    {
        name: 'Myntra',
        url: 'https://www.myntra.com/tops/nayam+by+lakshita/nayam-by-lakshita-puff-floral-embroidered-linen-shirt-collar-top/41513135/buy',
        merchant: 'myntra',
    },
    {
        name: 'Nykaa Fashion',
        url: 'https://www.nykaafashion.com/mytrident-cotton-white-finesse-hand-towels-pack-of-4-m/p/21833174',
        merchant: 'nykaa',
    },
] as const;

/**
 * Build a minimal, browser-free Crawlee-style context. Every page method a
 * handler touches is stubbed to resolve so the handler runs to completion
 * WITHOUT a real browser. We do not fake the merchant: each handler logs a
 * unique `[merchant]` tag as its first action, and that captured tag is the
 * deterministic proof of WHICH handler the router dispatched to.
 */
function makeCtx(url: string, label: string) {
    const logs: string[] = [];
    const pushed: Array<Record<string, unknown>> = [];
    const rec = (m: unknown) => {
        logs.push(String(m));
    };
    const log = { info: rec, debug: rec, warning: rec, error: rec };

    const page = {
        waitForLoadState: async () => {},
        waitForSelector: async () => ({}),
        title: async () => 'Mock Title',
        url: () => url,
        // Handlers pass a browser function; we ignore it and return a stub
        // shaped like ProductData (some handlers read product.features etc.
        // after evaluate). The merchant proof comes from the handler's own
        // log tag, not from these values.
        evaluate: async () => ({
            merchant: '__stub__',
            productId: null,
            title: null,
            url,
            features: [],
            specifications: {},
        }),
        locator: () => ({ innerText: async () => '', count: async () => 0 }),
        screenshot: async () => Buffer.from(''),
    };

    const request = { url, loadedUrl: url, label, userData: { label, merchant: label } };
    const pushData = async (d: Record<string, unknown>) => {
        pushed.push(d);
    };

    return { context: { page, request, log, pushData } as never, logs, pushed };
}

describe('detectMerchant() — URL → MerchantId', () => {
    it.each(CASES)('$name → $merchant', ({ url, merchant }) => {
        expect(detectMerchant(url)).toBe(merchant);
    });

    it('nykaafashion.com is distinct from nykaa.com but both → nykaa', () => {
        expect(detectMerchant('https://www.nykaafashion.com/x/p/1')).toBe('nykaa');
        expect(detectMerchant('https://www.nykaa.com/x/p/1')).toBe('nykaa');
    });

    it('unrelated domain → unknown', () => {
        expect(detectMerchant('https://www.ajio.com/x/p/1')).toBe('unknown');
    });
});

describe('router dispatch — mirrors main.ts (label = detectMerchant(url))', () => {
    it.each(CASES)('$name routes to the [$merchant] handler', async ({ url, merchant }) => {
        // Exactly what main.ts assigns as the request label.
        const label = detectMerchant(url);
        expect(label).toBe(merchant);

        const { context, logs, pushed } = makeCtx(url, label);
        await router(context);

        // The correct handler ran (its unique tag was logged)...
        expect(logs.some((l) => l.includes(`[${merchant}]`))).toBe(true);
        // ...and produced exactly one dataset record.
        expect(pushed.length).toBe(1);

        // Guards the reported 0.0.24 bug directly: a non-Amazon URL must
        // NEVER execute the Amazon handler.
        if (merchant !== 'amazon') {
            expect(logs.some((l) => l.includes('[amazon]'))).toBe(false);
        }
    });

    it('unknown label → default handler emits merchant="unknown" stub', async () => {
        const { context, pushed } = makeCtx('https://www.ajio.com/x/p/1', 'unknown');
        await router(context);
        expect(pushed.length).toBe(1);
        expect(pushed[0].merchant).toBe('unknown');
    });
});
