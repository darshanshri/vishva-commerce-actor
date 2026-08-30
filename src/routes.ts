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

        // Extract the first standalone number from a string, e.g.
        // "4.3 out of 5 stars" -> 4.3. parseNumber() strips all
        // non-digits and would wrongly merge "4.3...5" into "4.35".
        const parseFirstFloat = (value: string | null): number | null => {
            if (!value) return null;
            const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
            return match ? Number(match[0]) : null;
        };

        // Turn a raw byline / brand-row string into a clean brand name.
        // "Visit the Samsung Store" -> "Samsung", "Brand: Samsung" -> "Samsung".
        const cleanBrand = (value: string | null): string | null => {
            if (!value) return null;
            let brandName = value.replace(/\s+/g, ' ').trim();

            const visitMatch = brandName.match(
                /^Visit the\s+(.+?)\s+Store$/i,
            );
            if (visitMatch) return visitMatch[1].trim() || null;

            brandName = brandName
                .replace(/^Brand:\s*/i, '')
                .replace(/^Visit the\s+/i, '')
                .replace(/\s+Store$/i, '')
                .trim();

            return brandName || null;
        };

        // Strip Amazon image-size modifiers (e.g. "._SS40_." or
        // "._AC_SX679_.") to get the canonical full-size image URL.
        const normalizeImageUrl = (src: string): string =>
            src.replace(/\._[^./]*_\./, '.');

        // Heuristic: does a string look like leaked JS/CSS/markup rather
        // than a real, human-readable offer line?
        const looksLikeCode = (value: string): boolean =>
            /[{}<>]|function\s*\(|=>|window\.|document\.|@media|\bvar\s|;\s*$/.test(
                value,
            );

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

        // Rating text usually lives in the popover's title attribute or
        // the star-icon alt text, e.g. "4.3 out of 5 stars".
        const ratingText =
            attr('#acrPopover', 'title') ||
            text('#acrPopover .a-icon-alt') ||
            text('#averageCustomerReviews .a-icon-alt') ||
            text('[data-hook="rating-out-of-text"]');

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

        // The product-overview "Brand" row is the cleanest source
        // ("Samsung"); the byline ("Visit the Samsung Store") is a
        // fallback that we normalise with cleanBrand().
        const brand =
            cleanBrand(
                text(
                    '#productOverview_feature_div .po-brand td.a-span9',
                ),
            ) ||
            cleanBrand(
                text('#productOverview_feature_div .po-brand .po-break-word'),
            ) ||
            cleanBrand(text('#bylineInfo'));

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
        const seenImages = new Set<string>();

        const addImage = (raw: string | null): void => {
            if (!raw || !/^https?:\/\//.test(raw)) return;
            // Only accept product-image CDN URLs; this excludes sprites,
            // 1x1 tracking pixels, grey placeholders and UI icons.
            if (!/\/images\/I\//.test(raw)) return;
            if (/sprite|transparent|grey-pixel|pixel\.gif/i.test(raw)) return;

            const full = normalizeImageUrl(raw);
            if (seenImages.has(full)) return;
            seenImages.add(full);
            images.push(full);
        };

        // Main image: prefer the hi-res variant Amazon stashes on the node.
        const mainImage = document.querySelector(
            '#landingImage, #imgTagWrapperId img',
        );
        addImage(
            mainImage?.getAttribute('data-old-hires') ||
                mainImage?.getAttribute('src') ||
                null,
        );

        // Alternate-view thumbnails, normalised back to full size and
        // de-duplicated against the main image. Skip video thumbnails
        // (they carry a play-icon overlay and are not product photos).
        document.querySelectorAll('#altImages li').forEach((item) => {
            const isVideo =
                /video/i.test(item.className) ||
                item.querySelector('.play-icon-overlay') !== null;
            if (isVideo) return;

            item
                .querySelectorAll('img')
                .forEach((img) => addImage(img.getAttribute('src')));
        });

        // ----------------------------------------
        // SPECIFICATIONS
        // ----------------------------------------

        const specifications: Record<string, string> = {};

        // Remove Amazon's bidi marks (‎ / ‏), collapse spaces
        // and trim stray leading/trailing colons.
        const cleanSpec = (raw: string | null | undefined): string =>
            (raw || '')
                .replace(/[‎‏]/g, '')
                .replace(/\s+/g, ' ')
                .replace(/^[:\s]+|[:\s]+$/g, '')
                .trim();

        const addSpec = (
            keyRaw: string | null | undefined,
            valueRaw: string | null | undefined,
        ): void => {
            const key = cleanSpec(keyRaw);
            const value = cleanSpec(valueRaw);
            if (key && value && !(key in specifications)) {
                specifications[key] = value;
            }
        };

        // 1) Two-column tables: product overview + technical/detail tables.
        document
            .querySelectorAll(
                '#productOverview_feature_div tr, ' +
                '#productDetails_techSpec_section_1 tr, ' +
                '#productDetails_techSpec_section_2 tr, ' +
                '#productDetails_detailBullets_sections1 tr, ' +
                '#technicalSpecifications_section_1 tr',
            )
            .forEach((row) => {
                const cells = row.querySelectorAll('th, td');
                if (cells.length >= 2) {
                    addSpec(cells[0].textContent, cells[1].textContent);
                }
            });

        // 2) Detail-bullet lists: "<b>Key :</b> Value" list items.
        document
            .querySelectorAll(
                '#detailBullets_feature_div li, ' +
                '#detailBulletsWrapper_feature_div li',
            )
            .forEach((li) => {
                const boldKey = li.querySelector('.a-text-bold');
                if (!boldKey) return;
                const keyText = boldKey.textContent || '';
                const value = (li.textContent || '').replace(keyText, '');
                addSpec(keyText, value);
            });

        // ----------------------------------------
        // VARIANTS
        // ----------------------------------------

        // Only real twister swatch <li> elements — NOT arbitrary
        // [data-csa-c-item-id] nodes, which match large unrelated
        // page containers and leak page text into variants.
        // Genuine twister swatches are leaf <li> items. Legacy layouts
        // put the variant ASIN on data-csa-c-item-id inside
        // #twister_feature_div; the newer "inline twister" uses
        // [id^="inline-twister"]. We scope to those containers (plus the
        // classic #variation_*_name lists) so we never match the large
        // container node that concatenated the whole page into one blob.
        const variantElements = document.querySelectorAll(
            '#twister_feature_div li[data-csa-c-item-id], ' +
            '#twisterContainer li[data-csa-c-item-id], ' +
            '[id^="inline-twister"] li[data-csa-c-item-id], ' +
            '#variation_color_name li, ' +
            '#variation_size_name li, ' +
            '#variation_style_name li, ' +
            '#variation_pattern_name li',
        );

        const variants: { text: string; value: string | null }[] = [];
        const seenVariants = new Set<string>();

        variantElements.forEach((element) => {
            const rawTitle = element.getAttribute('title') || '';
            const label = (
                element.querySelector('.swatch-title-text-display')
                    ?.textContent ||
                element.querySelector('.swatch-title-text')?.textContent ||
                element.querySelector('.a-button-text')?.textContent ||
                element.querySelector('img')?.getAttribute('alt') ||
                rawTitle.replace(/^Click to select\s*/i, '') ||
                element.textContent ||
                ''
            )
                .replace(/\s+/g, ' ')
                .trim();

            const value =
                element.getAttribute('data-csa-c-item-id') ||
                element.getAttribute('data-defaultasin') ||
                element.getAttribute('data-dp-url') ||
                null;

            // Genuine swatch labels are short; reject empties, oversized
            // blobs and anything that looks like leaked code/markup.
            if (!label || label.length > 100) return;
            if (looksLikeCode(label)) return;

            const dedupeKey = `${label}::${value ?? ''}`;
            if (seenVariants.has(dedupeKey)) return;
            seenVariants.add(dedupeKey);

            variants.push({ text: label, value });
        });

        // ----------------------------------------
        // OFFERS / PROMOTIONS
        // ----------------------------------------

        // Target known offer/promotion widgets only. The previous
        // '#buybox .a-section' selector swallowed entire buybox
        // sections (scripts/markup included) — removed.
        const offerTexts: string[] = [];
        const seenOffers = new Set<string>();

        document
            .querySelectorAll(
                '#itembox-InstantBankDiscount .a-truncate-full, ' +
                '#itembox-NoCostEMI .a-truncate-full, ' +
                '#itembox-PartnerOffers .a-truncate-full, ' +
                '#itembox-Cashback .a-truncate-full, ' +
                '.vsx-offers-desktop-lv__cell .a-truncate-full, ' +
                '.offers-items .a-truncate-full, ' +
                '#promotions_feature_div .a-list-item, ' +
                '#applicablePromotionList_feature_div .a-list-item, ' +
                '#promoPriceBlockMessage_feature_div .a-list-item, ' +
                '#couponText',
            )
            .forEach((element) => {
                const offer = (element.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim();

                // Reject empties, over-long blobs and anything that
                // looks like leaked JS/CSS/markup.
                if (offer.length < 3 || offer.length > 300) return;
                if (looksLikeCode(offer)) return;
                if (seenOffers.has(offer)) return;

                seenOffers.add(offer);
                offerTexts.push(offer);
            });

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

            rating: parseFirstFloat(ratingText),
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
