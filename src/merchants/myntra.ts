import type { PlaywrightCrawlingContext } from '@crawlee/playwright';

/**
 * Myntra PDP handler.
 *
 * Primary extraction: JSON-LD (`script[type="application/ld+json"]`).
 * Myntra is a fashion marketplace with stable JSON-LD Product blocks
 * for most listings. CSS selectors are provided as fallbacks but marked
 * // NEEDS_VALIDATION — Myntra uses React with hashed classnames that
 * change on each deploy.
 *
 * Phase 1 constraints:
 *   - Never fabricate values. Null is correct when the source doesn't
 *     expose a field.
 *   - Optimizations applied here must not affect Amazon's handler.
 */
export async function handleMyntra(
    ctx: PlaywrightCrawlingContext,
): Promise<void> {
    const { page, request, log, pushData } = ctx;
    log.info(`[myntra] Scraping: ${request.url}`);

    await page.waitForLoadState('domcontentloaded');

    // Myntra is a React SPA; wait for the product title H1 which hydrates
    // after client-side render (~1–2 s on desktop proxy).
    await page
        .waitForSelector('h1.pdp-name, h1.pdp-title', { timeout: 15_000 })
        .catch(() => log.debug('[myntra] h1.pdp-name not found within 15 s — proceeding'));

    const product = await page.evaluate((pageUrl) => {
        const parseNumber = (v: unknown): number | null => {
            if (v == null) return null;
            const n = Number(String(v).replace(/[₹Rs.,\s]/g, ''));
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
        // Myntra PDPs: …/{brand}/{product-name}/{productId}/buy
        // Also exposed in window.__myx (Redux store injected as JSON).
        let productId: string | null = null;
        const buyMatch = pageUrl.match(/\/(\d+)\/buy(?:\?|$)/);
        if (buyMatch) {
            productId = buyMatch[1];
        } else {
            // Try Redux store as fallback — not always present
            try {
                const redux = (window as Window & { __myx?: Record<string, unknown> }).__myx;
                const pid =
                    (redux?.['pdpData'] as Record<string, unknown> | undefined)?.[
                        'id'
                    ];
                if (pid) productId = String(pid);
            } catch {
                // ignore
            }
        }

        // ── TITLE ────────────────────────────────────────────────────
        const title =
            (ld?.['name'] as string | undefined) ||
            document.querySelector('h1.pdp-name')?.textContent?.trim() || // NEEDS_VALIDATION
            document.querySelector('h1')?.textContent?.trim() ||
            null;

        // ── BRAND ────────────────────────────────────────────────────
        const ldBrand = ld?.['brand'];
        const brand =
            (typeof ldBrand === 'object' && ldBrand !== null
                ? (ldBrand as Record<string, unknown>)['name']
                : ldBrand) as string | undefined ||
            document.querySelector('h1.pdp-title a')?.textContent?.trim() || // NEEDS_VALIDATION
            document.querySelector('.pdp-name')?.previousElementSibling
                ?.textContent?.trim() ||
            null;

        // ── OFFERS ───────────────────────────────────────────────────
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
                : document.querySelector('.pdp-price strong')?.textContent?.trim() || // NEEDS_VALIDATION
                  document.querySelector('span.pdp-price strong')?.textContent?.trim() || // NEEDS_VALIDATION
                  null;

        const mrpText =
            document.querySelector('.pdp-mrp s')?.textContent?.trim() || // NEEDS_VALIDATION
            document.querySelector('span.pdp-mrp')?.textContent?.trim() || // NEEDS_VALIDATION
            null;

        const ldAvailability = (offerObj as Record<string, unknown> | null)
            ?.['availability'] as string | undefined;
        const availability =
            ldAvailability?.replace(/^.*#/, '') ||
            null;

        // ── RATING ───────────────────────────────────────────────────
        const ldRating = ld?.['aggregateRating'] as
            | Record<string, unknown>
            | undefined;
        const ratingVal = ldRating?.['ratingValue'];
        const rating =
            ratingVal != null ? parseFloat(String(ratingVal)) : null;

        const reviewCountVal = ldRating?.['reviewCount'];
        const reviewCount =
            reviewCountVal != null ? parseInt(String(reviewCountVal), 10) : null;

        // ── IMAGES ───────────────────────────────────────────────────
        const ldImages = ld?.['image'];
        const images: string[] = [];
        if (Array.isArray(ldImages)) {
            images.push(...(ldImages as string[]).filter((u) => typeof u === 'string'));
        } else if (typeof ldImages === 'string' && ldImages) {
            images.push(ldImages);
        }
        if (images.length === 0) {
            // NEEDS_VALIDATION
            document
                .querySelectorAll('div._2amPTt img, img.pdp-image') // NEEDS_VALIDATION
                .forEach((img) => {
                    const src =
                        img.getAttribute('src') ||
                        img.getAttribute('data-src') ||
                        '';
                    if (src && /^https?:\/\//.test(src)) images.push(src);
                });
        }

        // ── FEATURES ────────────────────────────────────────────────
        // Myntra renders "Product Details" as a list; CSS is speculative.
        const features: string[] = Array.from(
            document.querySelectorAll('ul.pdp-product-description-content li'), // NEEDS_VALIDATION
        )
            .map((el) => el.textContent?.trim() || '')
            .filter(Boolean);

        // ── SPECIFICATIONS ───────────────────────────────────────────
        // "Specifications" section on Myntra PDP. NEEDS_VALIDATION.
        const specifications: Record<string, string> = {};
        document
            .querySelectorAll('div.pdp-sizeguide-specs-container tr') // NEEDS_VALIDATION
            .forEach((row) => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                    const key = cells[0].textContent?.trim();
                    const value = cells[1].textContent?.trim();
                    if (key && value) specifications[key] = value;
                }
            });

        // ── VARIANTS (sizes) ─────────────────────────────────────────
        // NEEDS_VALIDATION — Myntra size selectors rendered as buttons
        const variants: { text: string; value: string | null }[] = Array.from(
            document.querySelectorAll('p.size-buttons-size-button'), // NEEDS_VALIDATION
        ).map((el) => ({
            text: el.textContent?.trim() || '',
            value: null,
        })).filter((v) => v.text.length > 0);

        // ── OFFERS / PROMOTIONS ──────────────────────────────────────
        const offerTexts: string[] = Array.from(
            document.querySelectorAll('div.pdp-offers-offer-text'), // NEEDS_VALIDATION
        )
            .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() || '')
            .filter((t) => t.length > 2 && t.length < 300);

        return {
            merchant: 'myntra' as const,
            productId,
            title: title || null,
            brand: typeof brand === 'string' ? brand : null,
            price: parseNumber(priceText),
            priceText: priceText || null,
            mrp: parseNumber(mrpText),
            mrpText: mrpText || null,
            rating: rating != null && Number.isFinite(rating) ? rating : null,
            reviewCount:
                reviewCount != null && Number.isFinite(reviewCount) ? reviewCount : null,
            availability: availability || null,
            seller: null,
            features,
            specifications,
            variants,
            images,
            offers: offerTexts,
            url: window.location.href,
            scrapedAt: new Date().toISOString(),
        };
    }, request.url);

    log.info(
        `[myntra] Done: title="${product.title ?? 'null'}" productId=${product.productId ?? 'null'}`,
    );
    // TEMPORARY routing diagnostic (Phase 1 live validation).
    log.info(
        `[ROUTE] handler selected: myntra | final loaded URL: ${request.loadedUrl ?? request.url} | extracted merchant: ${product.merchant}`,
    );
    await pushData(product);
}
