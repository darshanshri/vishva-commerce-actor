import { Actor } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

interface Input {
    urls: string[];
    mode?: 'FULL_PRODUCT' | 'PRICE_CHECK' | 'OFFER_CHECK';
    maxConcurrency?: number;
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {
    urls: [],
    mode: 'FULL_PRODUCT',
};

const urls = input.urls ?? [];
const mode = input.mode ?? 'FULL_PRODUCT';

if (!urls.length) {
    throw new Error('No product URLs provided.');
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    useApifyProxy: true,
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration,

    maxConcurrency: input.maxConcurrency ?? 1,

    maxRequestsPerCrawl: urls.length,

    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    async requestHandler({ page, request, log }) {
        const url = request.loadedUrl;

        log.info(`Scraping ${url}`);

        // Wait for the main product page to render.
        await page.waitForLoadState('domcontentloaded');

        await page.waitForTimeout(2000);

        const hostname = new URL(url).hostname;

        if (hostname.includes('amazon.')) {
            const product = await extractAmazonProduct(page, url, mode);

            await Actor.pushData(product);

            log.info(`Amazon product extracted: ${product.title}`);
            return;
        }

        throw new Error(`Unsupported marketplace: ${hostname}`);
    },
});

await crawler.run(urls);

await Actor.exit();


// ============================================================
// AMAZON
// ============================================================

async function extractAmazonProduct(
    page: any,
    url: string,
    mode: string,
) {
    const data = await page.evaluate((mode) => {

        const text = (selector: string): string | null => {
            const el = document.querySelector(selector);
            return el?.textContent?.replace(/\s+/g, ' ').trim() || null;
        };

        const texts = (selector: string): string[] => {
            return Array.from(document.querySelectorAll(selector))
                .map(el => el.textContent?.replace(/\s+/g, ' ').trim() || '')
                .filter(Boolean);
        };

        const attr = (
            selector: string,
            attribute: string,
        ): string | null => {
            const el = document.querySelector(selector);
            return el?.getAttribute(attribute) || null;
        };

        // -----------------------------
        // BASIC PRODUCT INFORMATION
        // -----------------------------

        const title =
            text('#productTitle') ||
            text('h1');

        const price =
            text('.priceToPay .a-offscreen') ||
            text('#corePrice_feature_div .a-offscreen') ||
            text('.a-price .a-offscreen');

        const mrp =
            text('.basisPrice .a-offscreen') ||
            text('.a-text-price .a-offscreen');

        const rating =
            text('#acrPopover') ||
            text('[data-hook="rating-out-of-text"]');

        const reviewCount =
            text('#acrCustomerReviewText') ||
            text('[data-hook="total-review-count"]');

        // -----------------------------
        // AVAILABILITY
        // -----------------------------

        const availability =
            text('#availability') ||
            text('#outOfStock');

        // -----------------------------
        // SELLER
        // -----------------------------

        const seller =
            text('#sellerProfileTriggerId') ||
            text('#merchant-info');

        // -----------------------------
        // FEATURES
        // -----------------------------

        const features = texts(
            '#feature-bullets ul li span.a-list-item'
        );

        // -----------------------------
        // PRODUCT DESCRIPTION
        // -----------------------------

        const description =
            text('#productDescription') ||
            text('#bookDescription_feature_div');

        // -----------------------------
        // SPECIFICATIONS
        // -----------------------------

        const specifications: Record<string, string> = {};

        document
            .querySelectorAll(
                '#productDetails_techSpec_section_1 tr, ' +
                '#productDetails_detailBullets_sections1 tr'
            )
            .forEach(row => {

                const cells = row.querySelectorAll('th, td');

                if (cells.length >= 2) {
                    const key =
                        cells[0].textContent
                            ?.replace(/\s+/g, ' ')
                            .trim();

                    const value =
                        cells[1].textContent
                            ?.replace(/\s+/g, ' ')
                            .trim();

                    if (key && value) {
                        specifications[key] = value;
                    }
                }
            });

        // -----------------------------
        // ASIN
        // -----------------------------

        let asin: string | null = null;

        const asinElement =
            document.querySelector(
                '#productDetails_detailBullets_sections1 tr'
            );

        const pageText =
            document.body.innerText;

        const asinMatch =
            pageText.match(
                /ASIN\s*[:\s]*([A-Z0-9]{10})/i
            );

        if (asinMatch) {
            asin = asinMatch[1];
        }

        // -----------------------------
        // IMAGES
        // -----------------------------

        const images = Array.from(
            document.querySelectorAll(
                '#landingImage, #altImages img'
            )
        )
            .map(img =>
                img.getAttribute('src') ||
                img.getAttribute('data-old-hires')
            )
            .filter(Boolean);

        // -----------------------------
        // VARIANTS
        // -----------------------------

        const variants: {
            name: string;
            values: string[];
        }[] = [];

        document
            .querySelectorAll(
                '#twister_feature_div .a-row, ' +
                '#variation_size_name, ' +
                '#variation_color_name, ' +
                '#variation_style_name'
            )
            .forEach(el => {

                const label =
                    el.querySelector('.a-form-label')
                        ?.textContent
                        ?.replace(/\s+/g, ' ')
                        .trim();

                const values =
                    Array.from(
                        el.querySelectorAll(
                            'option, .selection, .swatchSelect'
                        )
                    )
                        .map(v =>
                            v.textContent
                                ?.replace(/\s+/g, ' ')
                                .trim() || ''
                        )
                        .filter(Boolean);

                if (label && values.length) {
                    variants.push({
                        name: label,
                        values,
                    });
                }
            });

        // -----------------------------
        // RAW OFFER TEXT
        // -----------------------------

        const offerSection =
            document.querySelector('#offers') ||
            document.querySelector('#dealBadge_feature_div') ||
            document.querySelector('#promotions_feature_div');

        const offerText =
            offerSection?.textContent
                ?.replace(/\s+/g, ' ')
                .trim() || null;

        // -----------------------------
        // RETURN
        // -----------------------------

        return {
            merchant: 'amazon',

            url,

            asin,

            title,

            price,

            mrp,

            rating,

            reviewCount,

            availability,

            seller,

            features,

            description,

            specifications,

            variants,

            images,

            rawOfferText: offerText,

            mode,

            scrapedAt: new Date().toISOString(),
        };

    }, mode);

    return data;
}
