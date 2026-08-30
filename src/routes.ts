import { createPlaywrightRouter } from '@crawlee/playwright';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request, log, pushData }) => {
    log.info(`Scraping product page: ${request.url}`);

    const title = await page.title();

    const product = {
        url: request.loadedUrl,
        title,
        scrapedAt: new Date().toISOString(),
    };

    log.info(`Product: ${title}`);

    await pushData(product);
});
