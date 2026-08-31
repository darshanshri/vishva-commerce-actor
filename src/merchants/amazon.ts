import { Actor } from 'apify';
import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { isDebugMode } from '../utils.js';

/**
 * Amazon India PDP handler.
 *
 * Extraction selectors validated against B0H6WWPNYX (build 0.0.23).
 *
 * Phase 1 changes vs. the original routes.ts:
 *   - waitForTimeout(2000) replaced with waitForSelector('#productTitle')
 *     → saves 1.5–2 s on fast loads, waits up to 10 s on slow ones
 *   - Full diagnostics (screenshot, body text, selector enumeration)
 *     moved behind isDebugMode() → saves ~1.5 s per production run
 *   - Lightweight bot detection (page title only) always runs (~5 ms)
 *   - page.evaluate() extraction block is unchanged
 */
export async function handleAmazon({
    page,
    request,
    log,
    pushData,
}: PlaywrightCrawlingContext): Promise<void> {
    log.info(`[amazon] Scraping: ${request.url}`);

    await page.waitForLoadState('domcontentloaded');

    // Condition-based wait: proceed as soon as the primary product title
    // element appears, rather than sleeping for a fixed 2 s.
    // #productTitle is present in Amazon's server-rendered HTML and is
    // typically reachable within 500 ms. Falls through silently on timeout
    // so the extraction can still identify a bot page (productId = null).
    await page
        .waitForSelector('#productTitle', { timeout: 10_000 })
        .catch(() =>
            log.debug('[amazon] #productTitle did not appear within 10 s — proceeding'),
        );

    // ── DIAGNOSTICS (dev only) ──────────────────────────────────────────
    if (isDebugMode()) {
        try {
            log.info(`[DIAG] page.url(): ${page.url()}`);
            const diagTitle = await page.title();
            log.info(`[DIAG] page.title(): ${diagTitle}`);
            const bodyText = await page.locator('body').innerText().catch(() => '');
            log.info(`[DIAG] body.innerText (first 2000 chars):\n${bodyText.slice(0, 2000)}`);
            for (const sel of ['#productTitle', '#availability', '.a-price', '#ASIN', '#bylineInfo']) {
                const count = await page.locator(sel).count().catch(() => -1);
                log.info(`[DIAG] ${sel}: ${count > 0 ? 'FOUND' : 'missing'} (count=${count})`);
            }
            try {
                const screenshot = await page.screenshot({ fullPage: true });
                await Actor.setValue('DEBUG_SCREENSHOT', screenshot, { contentType: 'image/png' });
                log.info('[DIAG] Screenshot saved �� DEBUG_SCREENSHOT');
            } catch (e) {
                log.warning(`[DIAG] Screenshot failed: ${e}`);
            }
        } catch (e) {
            log.warning(`[DIAG] Diagnostics block error: ${e}`);
        }
    }

    // ── BOT DETECTION (always, ~5 ms) ───────────────────────────────────
    // Title-only check: avoids the ~200 ms body.innerText() serialization.
    // If productId comes back null the caller already handles it gracefully.
    const pageTitle = await page.title().catch(() => '');
    const BOT_SIGNALS = [
        '503',
        'robot check',
        'captcha',
        "sorry, we just need to make sure you're not a robot",
        'service unavailable',
        'enter the characters you see below',
        'to discuss automated access',
    ];
    const botMatches = BOT_SIGNALS.filter((s) => pageTitle.toLowerCase().includes(s));
    if (botMatches.length > 0) {
        log.warning(`[amazon] Bot/interstitial detected in title: "${pageTitle}" — ${botMatches.join(' | ')}`);
    }

    // ── EXTRACTION ──────────────────────────────────────────────────────
    // Runs in the browser's JS sandbox. All helper functions are inlined:
    // they cannot reference Node.js imports or TypeScript types outside
    // this closure. The extraction logic is identical to build 0.0.23.
    const product = await page.evaluate(() => {
        const text = (selector: string): string | null => {
            const element = document.querySelector(selector);
            return element?.textContent?.trim() || null;
        };

        const texts = (selector: string): string[] =>
            Array.from(document.querySelectorAll(selector))
                .map((el) => el.textContent?.trim() || '')
                .filter(Boolean);

        const attr = (selector: string, attribute: string): string | null => {
            const element = document.querySelector(selector);
            return element?.getAttribute(attribute) || null;
        };

        const parseNumber = (value: string | null): number | null => {
            if (!value) return null;
            const cleaned = value.replace(/₹/g, '').replace(/,/g, '').replace(/[^\d.]/g, '');
            const number = Number(cleaned);
            return Number.isFinite(number) ? number : null;
        };

        const parseFirstFloat = (value: string | null): number | null => {
            if (!value) return null;
            const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
            return match ? Number(match[0]) : null;
        };

        const cleanBrand = (value: string | null): string | null => {
            if (!value) return null;
            let brandName = value.replace(/\s+/g, ' ').trim();
            const visitMatch = brandName.match(/^Visit the\s+(.+?)\s+Store$/i);
            if (visitMatch) return visitMatch[1].trim() || null;
            brandName = brandName
                .replace(/^Brand:\s*/i, '')
                .replace(/^Visit the\s+/i, '')
                .replace(/\s+Store$/i, '')
                .trim();
            return brandName || null;
        };

        const normalizeImageUrl = (src: string): string =>
            src.replace(/\._[^./]*_\./, '.');

        const looksLikeCode = (value: string): boolean =>
            /[{}<>]|function\s*\(|=>|window\.|document\.|@media|\bvar\s|;\s*$/.test(value);

        // ── TITLE ──────────────────────────────────────────────────
        const title = text('#productTitle') || text('h1');

        // ── PRICE ──────────────────────────────────────────────────
        const priceText =
            text('.priceToPay .a-offscreen') ||
            text('.a-price .a-offscreen') ||
            text('#corePriceDisplay_desktop_feature_div .a-offscreen');

        // ── MRP ────────────────────────────────────────────────────
        const mrpText =
            text('.basisPrice .a-offscreen') ||
            text('.a-price.a-text-price .a-offscreen') ||
            text('span.a-text-price .a-offscreen');

        // ── RATING ─────────────────────────────────────────────────
        const ratingText =
            attr('#acrPopover', 'title') ||
            text('#acrPopover .a-icon-alt') ||
            text('#averageCustomerReviews .a-icon-alt') ||
            text('[data-hook="rating-out-of-text"]');

        // ── REVIEW COUNT ───────────────────────────────────────────
        const reviewText =
            text('#acrCustomerReviewText') ||
            text('[data-hook="total-review-count"]');

        // ── AVAILABILITY ───────────────────────────────────────────
        const availability = text('#availability span') || text('#outOfStock');

        // ── SELLER ─────────────────────────────────────────────────
        const seller = text('#sellerProfileTriggerId') || text('#sellerName');

        // ── BRAND ──────────────────────────────────────────────────
        const brand =
            cleanBrand(text('#productOverview_feature_div .po-brand td.a-span9')) ||
            cleanBrand(text('#productOverview_feature_div .po-brand .po-break-word')) ||
            cleanBrand(text('#bylineInfo'));

        // ── ASIN ───────────────────────────────────────────────────
        const asin =
            attr('#ASIN', 'value') ||
            document.querySelector('input[name="ASIN"]')?.getAttribute('value') ||
            null;

        // ── FEATURES ───────────────────────────────────────────────
        const features = texts('#feature-bullets ul li span.a-list-item');

        // ── IMAGES ─────────────────────────────────────────────────
        const images: string[] = [];
        const seenImages = new Set<string>();

        const addImage = (raw: string | null): void => {
            if (!raw || !/^https?:\/\//.test(raw)) return;
            if (!/\/images\/I\//.test(raw)) return;
            if (/sprite|transparent|grey-pixel|pixel\.gif/i.test(raw)) return;
            const full = normalizeImageUrl(raw);
            if (seenImages.has(full)) return;
            seenImages.add(full);
            images.push(full);
        };

        const mainImage = document.querySelector('#landingImage, #imgTagWrapperId img');
        addImage(
            mainImage?.getAttribute('data-old-hires') ||
            mainImage?.getAttribute('src') ||
            null,
        );

        document.querySelectorAll('#altImages li').forEach((item) => {
            const isVideo =
                /video/i.test(item.className) ||
                item.querySelector('.play-icon-overlay') !== null;
            if (isVideo) return;
            item.querySelectorAll('img').forEach((img) => addImage(img.getAttribute('src')));
        });

        // ── SPECIFICATIONS ─────────────────────────────────────────
        const specifications: Record<string, string> = {};

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
            if (key && value && !(key in specifications)) specifications[key] = value;
        };

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
                if (cells.length >= 2) addSpec(cells[0].textContent, cells[1].textContent);
            });

        document
            .querySelectorAll(
                '#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li',
            )
            .forEach((li) => {
                const boldKey = li.querySelector('.a-text-bold');
                if (!boldKey) return;
                const keyText = boldKey.textContent || '';
                const value = (li.textContent || '').replace(keyText, '');
                addSpec(keyText, value);
            });

        // ── VARIANTS ───────────────────────────────────────────────
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
                element.querySelector('.swatch-title-text-display')?.textContent ||
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

            if (!label || label.length > 100) return;
            if (looksLikeCode(label)) return;
            const dedupeKey = `${label}::${value ?? ''}`;
            if (seenVariants.has(dedupeKey)) return;
            seenVariants.add(dedupeKey);
            variants.push({ text: label, value });
        });

        // ── OFFERS ─────────────────────────────────────────────────
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
                const offer = (element.textContent || '').replace(/\s+/g, ' ').trim();
                if (offer.length < 3 || offer.length > 300) return;
                if (looksLikeCode(offer)) return;
                if (seenOffers.has(offer)) return;
                seenOffers.add(offer);
                offerTexts.push(offer);
            });

        return {
            merchant: 'amazon' as const,
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
        `[amazon] Done: title="${product.title ?? 'null'}" productId=${product.productId ?? 'null'}`,
    );
    // TEMPORARY routing diagnostic (Phase 1 live validation).
    log.info(
        `[ROUTE] handler selected: amazon | final loaded URL: ${request.loadedUrl ?? request.url} | extracted merchant: ${product.merchant}`,
    );
    await pushData(product);
}
