import { createPlaywrightRouter } from '@crawlee/playwright';
import { Actor } from 'apify';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request, log, pushData }) => {
    log.info(`Scraping Amazon product: ${request.url}`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // ============================================================
    // TEMPORARY DIAGNOSTICS — remove after diagnosing Amazon page.
    // Determines exactly which page Amazon returns before extraction.
    // Does not touch the extraction logic below.
    // ============================================================
    try {
        // 1. Current page URL (after any redirects)
        log.info(`[DIAG] page.url(): ${page.url()}`);

        // 2. Page <title>
        const pageTitle = await page.title();
        log.info(`[DIAG] page.title(): ${pageTitle}`);

        // 3. First ~2000 chars of visible body text
        const bodyText = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        log.info(
            `[DIAG] body.innerText (first 2000 chars):\n${bodyText.slice(0, 2000)}`,
        );

        // 4. Presence of key Amazon selectors
        const selectorsToCheck = [
            '#productTitle',
            '#availability',
            '.a-price',
            '#ASIN',
            '#bylineInfo',
        ];
        for (const sel of selectorsToCheck) {
            const count = await page.locator(sel).count().catch(() => -1);
            log.info(
                `[DIAG] selector ${sel}: ${count > 0 ? 'FOUND' : 'missing'} (count=${count})`,
            );
        }

        // 5. Detect common Amazon bot / interstitial / error pages
        const botSignals = [
            '503',
            'Robot Check',
            'CAPTCHA',
            "Sorry, we just need to make sure you're not a robot",
            'Service Unavailable',
            'Enter the characters you see below',
            'To discuss automated access',
        ];
        const haystack = `${pageTitle}\n${bodyText}`.toLowerCase();
        const matched = botSignals.filter((s) =>
            haystack.includes(s.toLowerCase()),
        );
        if (matched.length > 0) {
            log.warning(
                `[DIAG] BOT / INTERSTITIAL signals detected: ${matched.join(' | ')}`,
            );
        } else {
            log.info('[DIAG] No obvious bot/interstitial signals detected.');
        }

        // 6. Save a full-page screenshot to the default key-value store
        try {
            const screenshot = await page.screenshot({ fullPage: true });
            await Actor.setValue('DEBUG_SCREENSHOT', screenshot, {
                contentType: 'image/png',
            });
            log.info(
                '[DIAG] Screenshot saved to key-value store under key: DEBUG_SCREENSHOT',
            );
        } catch (screenshotErr) {
            log.warning(`[DIAG] Screenshot capture failed: ${screenshotErr}`);
        }
    } catch (diagErr) {
        log.warning(`[DIAG] Diagnostics block failed: ${diagErr}`);
    }
    // ============================================================
    // END TEMPORARY DIAGNOSTICS
    // ============================================================

    const product = await page.evaluate(() => {
        const text = (selector: string): string | null => {
            const element = document.querySelector(selector);
            return element?.textContent?.trim() || null;
        };

        const texts = (selector: string): string[] => {
            return Array.from(document.querySelectorAll(selector))
                .map((element) => element.textContent?.trim() || '')
                .filter(Boolean);
        };

        const attr = (
            selector: string,
            attribute: string,
        ): string | null => {
            const element = document.querySelector(selector);
            return element?.getAttribute(attribute) || null;
        };

        const parseNumber = (value: string | null): number | null => {
            if (!value) return null;

            const cleaned = value
                .replace(/₹/g, '')
                .replace(/,/g, '')
                .replace(/[^\d.]/g, '');

            const number = Number(cleaned);

            return Number.isFinite(number) ? number : null;
        };

        // ----------------------------------------
        // PRODUCT TITLE
        // ----------------------------------------

        const title =
            text('#productTitle') ||
            text('h1');

        // ----------------------------------------
        // PRICE
        // ----------------------------------------

        const priceText =
            text('.priceToPay .a-offscreen') ||
            text('.a-price .a-offscreen') ||
            text('#corePriceDisplay_desktop_feature_div .a-offscreen');

        // ----------------------------------------
        // MRP
        // ----------------------------------------

        const mrpText =
            text('.basisPrice .a-offscreen') ||
            text('.a-price.a-text-price .a-offscreen') ||
            text('span.a-text-price .a-offscreen');

        // ----------------------------------------
        // RATING
        // ----------------------------------------

        const ratingText =
            text('#acrPopover') ||
            text('[data-hook="average-star-rating"]');

        // ----------------------------------------
        // REVIEW COUNT
        // ----------------------------------------

        const reviewText =
            text('#acrCustomerReviewText') ||
            text('[data-hook="total-review-count"]');

        // ----------------------------------------
        // AVAILABILITY
        // ----------------------------------------

        const availability =
            text('#availability span') ||
            text('#outOfStock');

        // ----------------------------------------
        // SELLER
        // ----------------------------------------

        const seller =
            text('#sellerProfileTriggerId') ||
            text('#sellerName');

        // ----------------------------------------
        // BRAND
        // ----------------------------------------

        const brand =
            text('#bylineInfo') ||
            text(
                '#productOverview_feature_div .po-brand td.a-span9',
            );

        // ----------------------------------------
        // ASIN
        // ----------------------------------------

        const asin =
            attr('#ASIN', 'value') ||
            document
                .querySelector('input[name="ASIN"]')
                ?.getAttribute('value') ||
            null;

        // ----------------------------------------
        // FEATURES
        // ----------------------------------------

        const features = texts(
            '#feature-bullets ul li span.a-list-item',
        );

        // ----------------------------------------
        // IMAGES
        // ----------------------------------------

        const images: string[] = [];

        document
            .querySelectorAll(
                '#altImages img, #imageBlock img',
            )
            .forEach((img) => {
                const src = img.getAttribute('src');

                if (
                    src &&
                    !src.includes('sprite') &&
                    !src.includes('transparent')
                ) {
                    images.push(src);
                }
            });

        // ----------------------------------------
        // SPECIFICATIONS
        // ----------------------------------------

        const specifications: Record<string, string> = {};

        document
            .querySelectorAll(
                '#productDetails_techSpec_section_1 tr, ' +
                '#productDetails_detailBullets_sections1 tr, ' +
                '#technicalSpecifications_section_1 tr',
            )
            .forEach((row) => {
                const cells = row.querySelectorAll('th, td');

                if (cells.length >= 2) {
                    const key =
                        cells[0].textContent?.trim();

                    const value =
                        cells[1].textContent?.trim();

                    if (key && value) {
                        specifications[key] = value;
                    }
                }
            });

        // ----------------------------------------
        // VARIANTS
        // ----------------------------------------

        const variantElements = document.querySelectorAll(
            '#twister_feature_div [data-csa-c-item-id], ' +
            '#variation_size_name li, ' +
            '#variation_color_name li',
        );

        const variants = Array.from(variantElements)
            .map((element) => ({
                text:
                    element.textContent?.trim() || '',

                value:
                    element.getAttribute(
                        'data-csa-c-item-id',
                    ) ||
                    element.getAttribute('title') ||
                    null,
            }))
            .filter((variant) => variant.text);

        // ----------------------------------------
        // OFFERS / PROMOTIONS
        // ----------------------------------------

        const offerTexts = texts(
            '#offersDisplay_feature_div .a-list-item, ' +
            '#promotions_feature_div .a-list-item, ' +
            '#couponText, ' +
            '#buybox .a-section',
        );

        // ----------------------------------------
        // FINAL PRODUCT OBJECT
        // ----------------------------------------

        return {
            merchant: 'amazon',

            productId: asin,

            title,
            brand,

            price: parseNumber(priceText),
            priceText,

            mrp: parseNumber(mrpText),
            mrpText,

            rating: parseNumber(ratingText),
            reviewCount: parseNumber(reviewText),

            availability,
            seller,

            features,

            specifications,

            variants,

            images,

            offers: offerTexts,

            url: window.location.href,

            scrapedAt: new Date().toISOString(),
        };
    });

    log.info(
        `Extracted product: ${product.title ?? 'Unknown product'}`,
    );

    await pushData(product);
});
