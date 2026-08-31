import type { PlaywrightCrawlingContext } from '@crawlee/playwright';

/**
 * Nykaa PDP handler.
 *
 * Primary extraction: JSON-LD (`script[type="application/ld+json"]`).
 * Nykaa is a beauty/personal-care marketplace. Their PDPs consistently
 * include a Product JSON-LD block with structured price, brand, and
 * availability data.
 *
 * CSS-selector fallbacks are marked // NEEDS_VALIDATION — Nykaa uses
 * emotion/CSS-in-JS with hashed class names that change on each build.
 *
 * Phase 1 constraints:
 *   - Never fabricate values. Null is correct when the source doesn't
 *     expose a field.
 *   - Optimizations applied here must not affect Amazon's handler.
 */
export async function handleNykaa(ctx: PlaywrightCrawlingContext): Promise<void> {
    const { page, request, log, pushData } = ctx;
    log.info(`[nykaa] Scraping: ${request.url}`);

    await page.waitForLoadState('domcontentloaded');

    // Nykaa is a React SPA. Wait for the product h1 which renders after
    // hydration (~500 ms–2 s on desktop proxy).
    await page
        .waitForSelector('h1', { timeout: 15_000 })
        .catch(() => log.debug('[nykaa] h1 did not appear within 15 s — proceeding'));

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
        // Nykaa PDPs: …/{brand}/{product-name}/p/{productId}?skuId=…
        let productId: string | null = null;
        const pdpMatch = pageUrl.match(/\/p\/(\d+)(?:[/?]|$)/);
        if (pdpMatch) {
            productId = pdpMatch[1];
        } else {
            // skuId fallback
            const skuMatch = pageUrl.match(/[?&]skuId=(\d+)/);
            if (skuMatch) productId = skuMatch[1];
        }

        // ── TITLE ────────────────────────────────────────────────────
        const title =
            (ld?.['name'] as string | undefined) ||
            document.querySelector('h1')?.textContent?.trim() ||
            null;

        // ── BRAND ────────────────────────────────────────────────────
        const ldBrand = ld?.['brand'];
        const brand =
            (typeof ldBrand === 'object' && ldBrand !== null
                ? (ldBrand as Record<string, unknown>)['name']
                : ldBrand) as string | undefined ||
            // NEEDS_VALIDATION — emotion CSS class names
            document.querySelector('a.css-1s1zt1d')?.textContent?.trim() || // NEEDS_VALIDATION
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
                : // NEEDS_VALIDATION — Nykaa emotion CSS
                  document.querySelector('span.css-17x893w')?.textContent?.trim() || // NEEDS_VALIDATION
                  null;

        // MRP is not in standard JSON-LD; use a CSS selector.
        const mrpText =
            // NEEDS_VALIDATION
            document.querySelector('span.css-1i4uxid s')?.textContent?.trim() || // NEEDS_VALIDATION
            document.querySelector('s.css-frgviv')?.textContent?.trim() || // NEEDS_VALIDATION
            null;

        const ldAvailability = (offerObj as Record<string, unknown> | null)
            ?.['availability'] as string | undefined;
        const availability = ldAvailability?.replace(/^.*#/, '') || null;

        // ── RATING ───────────────────────────────────────────────────
        const ldRating = ld?.['aggregateRating'] as
            | Record<string, unknown>
            | undefined;
        const ratingVal = ldRating?.['ratingValue'];
        const rating = ratingVal != null ? parseFloat(String(ratingVal)) : null;

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
            document.querySelectorAll('div.css-qumrz0 img').forEach((img) => { // NEEDS_VALIDATION
                const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
                if (src && /^https?:\/\//.test(src)) images.push(src);
            });
        }

        // ── FEATURES ────────────────────────────────────────────────
        // Nykaa "Product Description" section. NEEDS_VALIDATION.
        const features: string[] = Array.from(
            document.querySelectorAll(
                'div.css-1o6crwm ul li, ' + // NEEDS_VALIDATION
                'div[class*="productDescription"] ul li', // NEEDS_VALIDATION
            ),
        )
            .map((el) => el.textContent?.trim() || '')
            .filter(Boolean);

        // ── SPECIFICATIONS ───────────────────────────────────────────
        // "Key Ingredients" / "How to Use" tables. NEEDS_VALIDATION.
        const specifications: Record<string, string> = {};
        document
            .querySelectorAll(
                'div.css-11i0f0l tr, ' + // NEEDS_VALIDATION
                'table.css-xxxxx tr', // NEEDS_VALIDATION
            )
            .forEach((row) => {
                const cells = row.querySelectorAll('td, th');
                if (cells.length >= 2) {
                    const key = cells[0].textContent?.trim();
                    const value = cells[1].textContent?.trim();
                    if (key && value) specifications[key] = value;
                }
            });

        // ── VARIANTS (shades / sizes) ────────────────────────────────
        // NEEDS_VALIDATION — Nykaa shade picker buttons
        const variants: { text: string; value: string | null }[] = Array.from(
            document.querySelectorAll(
                'div.css-1fmxm6v button, ' + // NEEDS_VALIDATION — shade buttons
                'div[class*="shadeOption"]', // NEEDS_VALIDATION
            ),
        )
            .map((el) => ({
                text:
                    el.getAttribute('aria-label')?.trim() ||
                    el.textContent?.trim() ||
                    '',
                value: el.getAttribute('data-id') || null,
            }))
            .filter((v) => v.text.length > 0);

        // ── OFFERS / PROMOTIONS ──────────────────────────────────────
        const offerTexts: string[] = Array.from(
            document.querySelectorAll(
                'div.css-1xfdcxa li, ' + // NEEDS_VALIDATION
                'ul[class*="offerList"] li', // NEEDS_VALIDATION
            ),
        )
            .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() || '')
            .filter((t) => t.length > 2 && t.length < 300);

        return {
            merchant: 'nykaa' as const,
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
        `[nykaa] Done: title="${product.title ?? 'null'}" productId=${product.productId ?? 'null'}`,
    );
    // TEMPORARY routing diagnostic (Phase 1 live validation).
    log.info(
        `[ROUTE] handler selected: nykaa | final loaded URL: ${request.loadedUrl ?? request.url} | extracted merchant: ${product.merchant}`,
    );
    await pushData(product);
}
