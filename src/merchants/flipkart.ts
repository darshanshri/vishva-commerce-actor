import type { PlaywrightCrawlingContext } from '@crawlee/playwright';

/**
 * Flipkart PDP handler.
 *
 * Primary extraction: JSON-LD (`script[type="application/ld+json"]`).
 * JSON-LD is server-rendered by Flipkart and survives CSS class renames.
 *
 * CSS-selector fallbacks are marked // NEEDS_VALIDATION — they were
 * derived from Flipkart's public DOM as of 2026-08 but Flipkart uses
 * hashed/rotating class names that may change without notice. Run a
 * benchmark against a real Flipkart PDP before relying on them.
 *
 * Phase 1 constraints:
 *   - Never fabricate values. Null is correct when the source doesn't
 *     expose a field.
 *   - Optimizations applied here must not affect Amazon's handler.
 */
export async function handleFliipkart(
    ctx: PlaywrightCrawlingContext,
): Promise<void> {
    const { page, request, log, pushData } = ctx;
    log.info(`[flipkart] Scraping: ${request.url}`);

    await page.waitForLoadState('domcontentloaded');

    // Wait for a stable landmark that indicates the PDP has rendered.
    // Flipkart server-renders the product title in an <h1>; this is
    // faster (~300 ms) than waiting for a full network-idle.
    await page
        .waitForSelector('h1', { timeout: 15_000 })
        .catch(() => log.debug('[flipkart] h1 did not appear within 15 s — proceeding'));

    const product = await page.evaluate((pageUrl) => {
        // ── JSON-LD helpers ──────────────────────────────────────────
        const parseNumber = (v: unknown): number | null => {
            if (v == null) return null;
            const n = Number(String(v).replace(/[₹,\s]/g, ''));
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
        // Flipkart PDPs carry pid in the query: …/p/itm{id}?pid=PID&…
        // The Actor is fed a short URL (dl.flipkart.com/s/…) with NO pid,
        // so we must read the FINAL redirected URL. window.location.href is
        // the post-redirect URL inside the browser; pageUrl (page.url() /
        // request.loadedUrl, passed in) is the reliable fallback. Verified
        // on live PDP: pid=COMHDG7CFDWVKYMZ (2026-08).
        const finalHref = window.location.href || pageUrl;
        const pidMatch =
            finalHref.match(/[?&]pid=([A-Z0-9]+)/i) || pageUrl.match(/[?&]pid=([A-Z0-9]+)/i);
        const productId = pidMatch ? pidMatch[1] : null;

        // ── TITLE ────────────────────────────────────────────────────
        const title =
            (ld?.['name'] as string | undefined) ||
            document.querySelector('h1.yhB1nd')?.textContent?.trim() || // NEEDS_VALIDATION
            document.querySelector('h1')?.textContent?.trim() ||
            null;

        // ── BRAND ────────────────────────────────────────────────────
        const ldBrand = ld?.['brand'];
        const brand =
            (typeof ldBrand === 'object' && ldBrand !== null
                ? (ldBrand as Record<string, unknown>)['name']
                : ldBrand) as string | undefined ||
            document.querySelector('a.G6XhRU')?.textContent?.trim() || // NEEDS_VALIDATION
            null;

        // ── OFFERS (price, mrp, availability, seller) ────────────────
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
                : document.querySelector('div.Nx9bqj')?.textContent?.trim() || // NEEDS_VALIDATION
                  null;

        // ── MRP ──────────────────────────────────────────────────────
        // Flipkart JSON-LD does NOT expose MRP/list price (verified live:
        // offers has price only — no highPrice/listPrice/priceSpecification).
        // MRP appears solely as a strikethrough price in the DOM, and class
        // names are hashed (rotate per build). A naive "first strikethrough
        // price on the page" is WRONG: the PDP has ~30 strikethrough prices
        // from recommendation carousels. So we ANCHOR to the buybox:
        //   1. find the leaf node whose own text equals the selling price,
        //   2. climb up to 5 ancestors and, within that subtree, take the
        //      first strikethrough price-node whose value exceeds it.
        // Verified live: anchors 64,990 → MRP 73,990 (2026-08). Requires a
        // known selling price; if absent we return null rather than guess.
        const priceShaped = /^(?:₹|Rs\.?)?\s*[\d,]{3,}$/;
        const digitsOf = (s: string): number => Number(s.replace(/[^\d]/g, ''));
        const ownPriceText = (el: Element): string | null => {
            const own = Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent || '')
                .join('')
                .trim();
            return own && priceShaped.test(own) ? own : null;
        };
        const isLineThrough = (el: Element): boolean => {
            const cs = window.getComputedStyle(el);
            return /line-through/.test(cs.textDecorationLine || cs.textDecoration || '');
        };

        const sellNum = parseNumber(priceText);
        let mrpText: string | null = null;
        if (sellNum != null) {
            let sellNode: Element | null = null;
            for (const el of Array.from(document.querySelectorAll('div, span'))) {
                const p = ownPriceText(el);
                if (p && digitsOf(p) === sellNum) {
                    sellNode = el;
                    break;
                }
            }
            let anc: Element | null = sellNode;
            for (let lvl = 0; lvl < 5 && anc; lvl++) {
                const struck = Array.from(anc.querySelectorAll('div, span')).find((el) => {
                    const p = ownPriceText(el);
                    return p != null && isLineThrough(el) && digitsOf(p) > sellNum;
                });
                if (struck) {
                    mrpText = ownPriceText(struck);
                    break;
                }
                anc = anc.parentElement;
            }
        }

        // ── AVAILABILITY ─────────────────────────────────────────────
        // JSON-LD gives a schema.org URL (e.g. "https://schema.org/InStock").
        // Normalize to a human string. The last path segment is the enum.
        const normalizeAvailability = (raw: string | null | undefined): string | null => {
            if (!raw) return null;
            const token = raw.split(/[/#]/).pop()?.toLowerCase() || '';
            const map: Record<string, string> = {
                instock: 'In stock',
                outofstock: 'Out of stock',
                soldout: 'Out of stock',
                preorder: 'Pre-order',
                presale: 'Pre-order',
                backorder: 'Backorder',
                limitedavailability: 'Limited availability',
                discontinued: 'Discontinued',
                onlineonly: 'In stock',
                instoreonly: 'In store only',
            };
            return map[token] || raw;
        };

        const ldAvailability = (offerObj as Record<string, unknown> | null)
            ?.['availability'] as string | undefined;
        const availability =
            normalizeAvailability(ldAvailability) ||
            document.querySelector('div._6R5TMN')?.textContent?.trim() || // NEEDS_VALIDATION
            null;

        const seller =
            (offerObj as Record<string, unknown> | null)?.['seller'] != null
                ? String((offerObj as Record<string, unknown>)['seller'])
                : document.querySelector('div.NqpwHC')?.textContent?.trim() || // NEEDS_VALIDATION
                  null;

        // ── RATING ───────────────────────────────────────────────────
        const ldRating = ld?.['aggregateRating'] as
            | Record<string, unknown>
            | undefined;
        const ratingVal = ldRating?.['ratingValue'];
        const rating =
            ratingVal != null
                ? parseFloat(String(ratingVal))
                : null;

        const reviewCountVal = ldRating?.['reviewCount'];
        const reviewCount =
            reviewCountVal != null
                ? parseInt(String(reviewCountVal), 10)
                : null;

        // ── IMAGES ───────────────────────────────────────────────────
        const ldImages = ld?.['image'];
        const images: string[] = [];
        if (Array.isArray(ldImages)) {
            images.push(...(ldImages as string[]).filter((u) => typeof u === 'string'));
        } else if (typeof ldImages === 'string' && ldImages) {
            images.push(ldImages);
        }
        if (images.length === 0) {
            // NEEDS_VALIDATION — Flipkart loads high-res images into data-src
            document.querySelectorAll('img._396cs4').forEach((img) => { // NEEDS_VALIDATION
                const src =
                    img.getAttribute('data-src') ||
                    img.getAttribute('src') ||
                    '';
                if (src && /^https?:\/\//.test(src)) images.push(src);
            });
        }

        // ── FEATURES (showcase / product-detail blocks) ─────────────
        // Flipkart renders each descriptive feature as a 2-child div:
        // child0 is a leaf TITLE ("Lasting Battery") and child1 is a
        // sentence DESCRIPTION. Class names are hashed, so we detect this
        // SEMANTICALLY and require the description to be a real sentence
        // (length + word count + lowercase words). That excludes footer/
        // nav concatenations, spec rows, and price labels — no hardcoded,
        // product-specific titles. Verified live: 9–10 clean blocks, zero
        // recommendation/nav leakage (2026-08). Descriptions are the
        // DOM-truncated preview (~100 chars); the full text sits behind a
        // per-block "more" toggle we deliberately do not click.
        const features: string[] = [];
        {
            // A group-header wrapper's body contains nested key/value rows;
            // a real feature description never does. Guards against spec
            // group-bodies being misread as features if the spec tab ever
            // happens to be pre-rendered (fresh Actor navigations default to
            // the showcase, so specs are absent here — validated live).
            const featureHasNestedRow = (node: Element): boolean => {
                for (const d of Array.from(node.querySelectorAll('div'))) {
                    const kids = d.children;
                    if (
                        kids.length >= 2 &&
                        kids[0].children.length === 0 &&
                        (kids[0].textContent || '').trim()
                    ) {
                        return true;
                    }
                }
                return false;
            };
            const seenFeature = new Set<string>();
            Array.from(document.querySelectorAll('div')).forEach((d) => {
                const kids = Array.from(d.children);
                if (kids.length !== 2) return;
                if (kids[0].children.length !== 0) return; // title must be a leaf
                const t = (kids[0].textContent || '').replace(/\s+/g, ' ').trim();
                const desc = (kids[1].textContent || '')
                    .replace(/\s+/g, ' ')
                    .replace(/\.?\.\.\s*more$/i, '')
                    .replace(/\s*more$/i, '')
                    .trim();
                if (t.length < 3 || t.length > 45) return;
                if (/[:|₹]/.test(t) || /^\d/.test(t)) return; // not a spec/price label
                const words = desc.split(' ').filter(Boolean);
                if (desc.length < 45 || words.length < 7) return; // must be a sentence
                if ((desc.match(/\b[a-z]{2,}\b/g) || []).length < 5) return;
                if (featureHasNestedRow(kids[1])) return; // guard: not a spec group body
                // Concatenated spec text has many camelCase joins
                // ("TouchscreenNoScreen"); real prose has ~none.
                if ((desc.match(/[a-z][A-Z]/g) || []).length > 2) return;
                if (seenFeature.has(t)) return;
                seenFeature.add(t);
                features.push(`${t}: ${desc}`);
            });
        }

        // ── SPECIFICATIONS ───────────────────────────────────────────
        // Filled by a SECOND pass in the handler below (after activating
        // the Specifications tab, which lazy-renders the table). Left empty
        // here so the initial-DOM pass never emits a partial spec set.
        const specifications: Record<string, string> = {};

        // ── OFFERS ───────────────────────────────────────────────────
        // Validated live (2026-08): this PDP exposes no reliably-scopeable
        // offer block. The single genuine buybox offer ("No Cost EMI…") is
        // detached from the price node (>8 ancestors away), while ~24
        // "₹X with Bank offer" strings come from recommendation carousels.
        // Rather than emit recommendation noise, return []. Revisit once we
        // validate against an offer-rich PDP with a populated "Available
        // offers" block.
        const offerTexts: string[] = [];

        return {
            merchant: 'flipkart' as const,
            productId,
            title: title || null,
            brand: typeof brand === 'string' ? brand : null,
            price: parseNumber(priceText),
            priceText: priceText || null,
            mrp: parseNumber(mrpText),
            mrpText: mrpText || null,
            rating: rating != null && Number.isFinite(rating) ? rating : null,
            reviewCount: reviewCount != null && Number.isFinite(reviewCount) ? reviewCount : null,
            availability: availability || null,
            seller: seller || null,
            features,
            specifications,
            variants: [],
            images,
            offers: offerTexts,
            url: window.location.href,
            scrapedAt: new Date().toISOString(),
        };
        // Pass the FINAL redirected URL (page.url() → request.loadedUrl →
        // original) so pid extraction never depends on the short input URL.
    }, page.url() || request.loadedUrl || request.url);

    // ── SPECIFICATIONS (second pass) ─────────────────────────────────
    // Flipkart lazy-renders the spec table only once the Specifications
    // tab is activated (its content is unmounted until then — which is why
    // this runs AFTER the features pass above, so activating it does not
    // wipe the still-mounted showcase blocks). We click the tab, poll until
    // a spec row hydrates (bounded ≤3 s — evidence-based, not an arbitrary
    // wait), then extract key/value rows scoped to the spec section.
    // Validated live: 58 clean pairs, zero nav/offer/recommendation/
    // group-header leakage (2026-08). If it never hydrates, returns {} —
    // never fabricated.
    const specifications = await page.evaluate(async () => {
        const ownText = (el: Element): string =>
            Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent || '')
                .join('')
                .trim();
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // Activate the Specifications tab(s) to trigger the lazy render.
        Array.from(document.querySelectorAll('div, span, a, li'))
            .filter((el) => /^Specifications$/i.test(ownText(el)))
            .forEach((el) => {
                try {
                    (el as HTMLElement).click();
                } catch {
                    /* ignore */
                }
            });

        // A spec row is a div whose first child is a non-empty leaf.
        const rowReady = (): boolean =>
            Array.from(document.querySelectorAll('div')).some((d) => {
                const k = d.children[0];
                return (
                    !!k &&
                    k.children.length === 0 &&
                    !!(k.textContent || '').trim() &&
                    d.children.length >= 2
                );
            });
        for (let i = 0; i < 15 && !rowReady(); i++) await sleep(200);

        // A group-header wrapper contains a nested key/value row; a real
        // spec value never does. Used to drop "General", "In the Box", etc.
        const hasNestedRow = (node: Element): boolean => {
            for (const d of Array.from(node.querySelectorAll('div'))) {
                const kids = d.children;
                if (
                    kids.length >= 2 &&
                    kids[0].children.length === 0 &&
                    (kids[0].textContent || '').trim()
                ) {
                    return true;
                }
            }
            return false;
        };
        const specRow = (d: Element): [string, string] | null => {
            const kids = Array.from(d.children);
            if (kids.length < 2 || kids.length > 3) return null;
            if (kids[0].children.length !== 0) return null; // key is a leaf
            if (kids[2] !== undefined && (kids[2].textContent || '').trim() !== '') return null;
            const k = (kids[0].textContent || '').replace(/\s+/g, ' ').trim();
            const v = (kids[1].textContent || '').replace(/\s+/g, ' ').trim();
            if (!k || !v || k.length > 40 || k === v) return null;
            if (hasNestedRow(kids[1])) return null; // reject group-header wrappers
            return [k, v];
        };

        // Scope to the spec SECTION: anchor on the "Specifications" heading,
        // climb while row count grows but stop before Reviews/related items
        // (prevents bleeding into recommendation content).
        const STOP =
            /Ratings & Reviews|Questions and Answers|Products related to this item|Similar products/i;
        const headings = Array.from(
            document.querySelectorAll('div, span, h1, h2, h3'),
        ).filter((el) => /^Specifications$/i.test(ownText(el)));
        let bestAnc: Element | null = null;
        let bestCount = 0;
        for (const h of headings) {
            let anc: Element | null = h;
            for (let lvl = 0; lvl < 9 && anc; lvl++) {
                if (STOP.test(anc.textContent || '')) break;
                const n = Array.from(anc.querySelectorAll('div')).filter((d) => specRow(d)).length;
                if (n > bestCount) {
                    bestCount = n;
                    bestAnc = anc;
                }
                anc = anc.parentElement;
            }
        }

        const out: Record<string, string> = {};
        if (bestAnc) {
            Array.from(bestAnc.querySelectorAll('div')).forEach((d) => {
                const kv = specRow(d);
                if (kv && !(kv[0] in out)) out[kv[0]] = kv[1];
            });
        }
        return out;
    });
    product.specifications = specifications;

    log.info(
        `[flipkart] Done: title="${product.title ?? 'null'}" productId=${product.productId ?? 'null'} specs=${Object.keys(specifications).length} features=${product.features.length}`,
    );
    // TEMPORARY routing diagnostic (Phase 1 live validation).
    log.info(
        `[ROUTE] handler selected: flipkart | final loaded URL: ${request.loadedUrl ?? request.url} | extracted merchant: ${product.merchant}`,
    );
    await pushData(product);
}
