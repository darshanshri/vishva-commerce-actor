import { createPlaywrightRouter } from '@crawlee/playwright';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request, log, pushData }) => {
    log.info(`Scraping Amazon product: ${request.url}`);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

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

        const title =
            text('#productTitle') ||
            text('h1');

        const priceText =
            text('.priceToPay .a-offscreen') ||
            text('.a-price .a-offscreen') ||
            text('#corePriceDisplay_desktop_feature_div .a-offscreen');

        const mrpText =
            text('.basisPrice .a-offscreen') ||
            text('.a-price.a-text-price .a-offscreen') ||
            text('span.a-text-price .a-offscreen');

        const ratingText =
            text('#acrPopover') ||
            text('[data-hook="average-star-rating"]');

        const reviewText =
            text('#acrCustomerReviewText') ||
            text('[data-hook="total-review-count"]');

        const availability =
            text('#availability span') ||
            text('#outOfStock');

        const seller =
            text('#sellerProfileTriggerId') ||
            text('#sellerName');

        const brand =
            text('#bylineInfo') ||
            text('#productOverview_feature_div .po-brand td.a-span9');

        const asin =
            attr('#ASIN', 'value') ||
            document.querySelector('input[name="ASIN"]')?.getAttribute('value') ||
            null;

        const features = texts(
            '#feature-bullets ul li span.a-list-item',
        );

        const images = Array.from(
            document.querySelectorAll(
                '#altImages img, #imageBlock img',
            ),
        )
            .map((img) => img.getAttribute('src'))
            .filter(
                (src): src is string =>
                    Boolean(src) &&
                    !src.includes('sprite') &&
                    !src.includes('transparent'),
            );

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
                    const key = cells[0].textContent?.trim();
                    const value = cells[1].textContent?.trim();

                    if (key && value) {
                        specifications[key] = value;
                    }
                }
            });

        const variantElements = document.querySelectorAll(
            '#twister_feature_div [data-csa-c-item-id], ' +
            '#variation_size_name li, ' +
            '#variation_color_name li',
        );

        const variants = Array.from(variantElements)
            .map((element) => ({
                text: element.textContent?.trim() || '',
                value:
                    element.getAttribute('data-csa-c-item-id') ||
                    element.getAttribute('title') ||
                    null,
            }))
            .filter((variant) => variant.text);

        const offerTexts = texts(
            '#offersDisplay_feature_div .a-list-item, ' +
            '#promotions_feature_div .a-list-item, ' +
            '#couponText, ' +
            '#buybox .a-section',
        );

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
