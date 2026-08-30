import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor } from 'apify';

import { router } from './routes.js';

interface Input {
    startUrls: {
        url: string;
        method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'OPTIONS' | 'CONNECT' | 'PATCH';
        headers?: Record<string, string>;
        userData?: Record<string, unknown>;
    }[];

    maxRequestsPerCrawl?: number;
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {
    startUrls: [],
};

const {
    startUrls = [],
    maxRequestsPerCrawl = 10,
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration({
    checkAccess: true,
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration,

    maxRequestsPerCrawl,

    requestHandler: router,

    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
});

await crawler.run(startUrls);

await Actor.exit();
