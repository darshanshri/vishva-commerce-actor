import type { PlaywrightCrawlingContext } from '@crawlee/playwright';

/**
 * Flipkart PDP handler.
 *
 * Primary extraction: JSON-LD (`script[type="application/ld+json"]`).
 * JSON-LD is server-rendered by Flipkart and survives CSS class renames.
 *
 * CSS-selector fallbacks are marked // NEEDS_VALIDATION — they were
 * derived from Flipkart's public DOM as of 2026-08 but Flipkart uses
 * hashed/rotating class names that may change without notice. Run a
 * benchmark against a real Flipkart PDP before relying on them.
 *
 * Phase 1 constraints:
 *   - Never fabricate values. Null is correct when the source doesn't
 *     expose a field.
 *   - Optimizations applied here must not affect Amazon's handler.
 */
export async function handleFliipkart(
    ctx: PlaywrightCrawlingContext,
): Promise<void> {
    const { page, request, log, pushData } = ctx;
    log.info(`[flipkart] Scraping: ${request.url}`);

    await page.waitForLoadState('domcontentloaded');

    // Wait for a stable landmark that indicates the PDP has rendered.
    // Flipkart server-renders the product title in an <h1>; this is
    // faster (~300 ms) than waiting for a full network-idle.
    await page
        .waitForSelector('h1', { timeout: 15_000 })
        .catch(() => log.debug('[flipkart] h1 did not appear within 15 s — proceeding'));

    const product = await page.evaluate((pageUrl) => {
        // ── JSON-LD helpers ──────────────────────────────────────────
        const parseNumber = (v: unknown): number | null => {
            if (v == null) return null;
            const n = Number(String(v).replace(/[₹,\s]/g, ''));
            return Number.isFinite(n) ? n : null;
        };

        const firstJsonLd = (type: string): Record<string, unknown> | null => {
            for (const el of Array.from(
                document.querySelectorAll('script[type="application/ld+json"]'),
            )) {
                try {
                    const data = JSON.parse(el.textContent || '');
                    const items: unknown[] = Array.isArray(data) ? data : [data];
                    for (const item of items) {
                        if (
                            item &&
                            typeof item === 'object' &&
                            (item as Record<string, unknown>)['@type'] === type
                        ) {
                            return item as Record<string, unknown>;
                        }
                    }
                } catch {
                    // ignore malformed scripts
                }
            }
            return null;
        };

        const ld = firstJsonLd('Product');

        // ── PRODUCT ID ───────────────────────────────────────────────
        // Flipkart PDPs: …/p/itm{id}?pid=PID&…
        const pidMatch = pageUrl.match(/[?&]pid=([A-Z0-9]+)/i);
        const productId = pidMatch ? pidMatch[1] : null;

        // ── TITLE ────────────────────────────────────────────────────
        const title =
            (ld?.['name'] as string | undefined) ||
            document.querySelector('h1.yhB1nd')?.textContent?.trim() || // NEEDS_VALIDATION
            document.querySelector('h1')?.textContent?.trim() ||
            null;

        // ── BRAND ────────────────────────────────────────────────────
        const ldBrand = ld?.['brand'];
        const brand =
            (typeof ldBrand === 'object' && ldBrand !== null
                ? (ldBrand as Record<string, unknown>)['name']
                : ldBrand) as string | undefined ||
            document.querySelector('a.G6XhRU')?.textContent?.trim() || // NEEDS_VALIDATION
            null;

        // ── OFFERS (price, mrp, availability, seller) ────────────────
        const ldOffers = ld?.['offers'];
        const offerObj =
            Array.isArray(ldOffers) && ldOffers.length > 0
                ? ldOffers[0]
                : typeof ldOffers === 'object' && ldOffers !== null
                ? ldOffers
                : null;

        const priceText =
            (offerObj as Record<string, unknown> | null)?.['price'] != null
                ? String((offerObj as Record<string, unknown>)['price'])
                : document.querySelector('div.Nx9bqj')?.textContent?.trim() || // NEEDS_VALIDATION
                  null;

        const mrpText =
            document.querySelector('div.yRaY8j')?.textContent?.trim() || // NEEDS_VALIDATION
            null;

        const ldAvailability = (offerObj as Record<string, unknown> | null)
            ?.['availability'] as string | undefined;
        const availability =
            ldAvailability?.replace(/^.*#/, '') ||
            document.querySelector('div._6R5TMN')?.textContent?.trim() || // NEEDS_VALIDATION
            null;

        const seller =
            (offerObj as Record<string, unknown> | null)?.['seller'] != null
                ? String((offerObj as Record<string, unknown>)['seller'])
                : document.querySelector('div.NqpwHC')?.textContent?.trim() || // NEEDS_VALIDATION
                  null;

        // ── RATING ───────────────────────────────────────────────────
        const ldRating = ld?.['aggregateRating'] as
            | Record<string, unknown>
            | undefined;
        const ratingVal = ldRating?.['ratingValue'];
        const rating =
            ratingVal != null
                ? parseFloat(String(ratingVal))
                : null;

        const reviewCountVal = ldRating?.['reviewCount'];
        const reviewCount =
            reviewCountVal != null
                ? parseInt(String(reviewCountVal), 10)
                : null;

        // ── IMAGES ───────────────────────────────────────────────────
        const ldImages = ld?.['image'];
        const images: string[] = [];
        if (Array.isArray(ldImages)) {
            images.push(...(ldImages as string[]).filter((u) => typeof u === 'string'));
        } else if (typeof ldImages === 'string' && ldImages) {
            images.push(ldImages);
        }
        if (images.length === 0) {
            // NEEDS_VALIDATION — Flipkart loads high-res images into data-src
            document.querySelectorAll('img._396cs4').forEach((img) => { // NEEDS_VALIDATION
                const src =
                    img.getAttribute('data-src') ||
                    img.getAttribute('src') ||
                    '';
                if (src && /^https?:\/\//.test(src)) images.push(src);
            });
        }

        // ── FEATURES ────────────────────────────────────────────────
        // NEEDS_VALIDATION — Flipkart highlights are in a flex-row of divs
        const features: string[] = Array.from(
            document.querySelectorAll('div._4amez0 ul li, ul.Jkd1Ry li'), // NEEDS_VALIDATION
        )
            .map((el) => el.textContent?.trim() || '')
            .filter(Boolean);

        // ── SPECIFICATIONS ───────────────────────────────────────────
        // NEEDS_VALIDATION — Flipkart spec table uses row/col divs
        const specifications: Record<string, string> = {};
        document
            .querySelectorAll('div._14cfVK, div.GNKN4t') // NEEDS_VALIDATION
            .forEach((row) => {
                const key =
                    row.querySelector('td._7eVTh4, div.col._2H87gM')?.textContent?.trim(); // NEEDS_VALIDATION
                const value =
                    row.querySelector('td.Izz52n, div.col.JRY5G_')?.textContent?.trim(); // NEEDS_VALIDATION
                if (key && value) specifications[key] = value;
            });

        // ── OFFERS / PROMOTIONS ──────────────────────────────────────
        const offerTexts: string[] = Array.from(
            document.querySelectorAll('div.lXl6tz, li._1t7JaC'), // NEEDS_VALIDATION
        )
            .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() || '')
            .filter((t) => t.length > 2 && t.length < 300);

        return {
            merchant: 'flipkart' as const,
            productId,
            title: title || null,
            brand: typeof brand === 'string' ? brand : null,
            price: parseNumber(priceText),
            priceText: priceText || null,
            mrp: parseNumber(mrpText),
            mrpText: mrpText || null,
            rating: rating != null && Number.isFinite(rating) ? rating : null,
            reviewCount: reviewCount != null && Number.isFinite(reviewCount) ? reviewCount : null,
            availability: availability || null,
            seller: seller || null,
            features,
            specifications,
            variants: [],
            images,
            offers: offerTexts,
            url: window.location.href,
            scrapedAt: new Date().toISOString(),
        };
    }, request.url);

    log.info(
        `[flipkart] Done: title="${product.title ?? 'null'}" productId=${product.productId ?? 'null'}`,
    );
    // TEMPORARY routing diagnostic (Phase 1 live validation).
    log.info(
        `[ROUTE] handler selected: flipkart | final loaded URL: ${request.loadedUrl ?? request.url} | extracted merchant: ${product.merchant}`,
    );
    await pushData(product);
}
