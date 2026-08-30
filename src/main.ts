import { Actor } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

interface Input {
    startUrls: Array<{
        url: string;
    }>;
    maxConcurrency?: number;
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {
    startUrls: [],
};

if (!input.startUrls?.length) {
    throw new Error('No product URLs provided.');
}

const crawler = new PlaywrightCrawler({
    maxConcurrency: input.maxConcurrency ?? 1,

    async requestHandler({ page, request, log }) {
        log.info(`Scraping: ${request.url}`);

        await page.waitForLoadState('domcontentloaded');

        // Give dynamic product sections a moment to render.
        await page.waitForTimeout(3000);

        const title = await page.title();

        log.info(`Page title: ${title}`);

        const data = await page.evaluate(() => {
            const bodyText = document.body.innerText;

            return {
                url: window.location.href,
                title: document.title,
                bodyText,
                scrapedAt: new Date().toISOString(),
            };
        });

        await Actor.pushData(data);
    },
});

await crawler.run(input.startUrls);

await Actor.exit();
