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

    // Navigation now resolves at 'commit' (see preNavigationHook). Wait for the
    // ACTUAL primary extraction source: an application/ld+json script that parses
    // to @type "Product" WITH a present offers.price — not merely "any ld+json".
    // On the short-URL client-routed fallback the Product JSON-LD is injected
    // late, so "any ld+json exists" resolved before price/brand/rating/
    // availability/images were in the DOM and they came back null. This mirrors
    // the exact firstJsonLd('Product') + offers-shape semantics the extraction
    // below relies on. Bounded (15 s, unchanged); on miss we fall through to the
    // h1 wait + CSS fallbacks rather than stalling.
    await page
        .waitForFunction(
            () => {
                for (const el of Array.from(
                    document.querySelectorAll('script[type="application/ld+json"]'),
                )) {
                    try {
                        const data: unknown = JSON.parse(el.textContent || '');
                        const items: unknown[] = Array.isArray(data) ? data : [data];
                        for (const item of items) {
                            if (
                                !item ||
                                typeof item !== 'object' ||
                                (item as Record<string, unknown>)['@type'] !== 'Product'
                            ) {
                                continue;
                            }
                            const ldOffers = (item as Record<string, unknown>)['offers'];
                            const offerObj =
                                Array.isArray(ldOffers) && ldOffers.length > 0
                                    ? (ldOffers[0] as Record<string, unknown>)
                                    : typeof ldOffers === 'object' && ldOffers !== null
                                      ? (ldOffers as Record<string, unknown>)
                                      : null;
                            if (offerObj && offerObj['price'] != null) return true;
                        }
                    } catch {
                        // ignore malformed scripts
                    }
                }
                return false;
            },
            undefined,
            { timeout: 15_000 },
        )
        .catch(() =>
            log.debug(
                '[flipkart] Product JSON-LD (with offers.price) did not appear within 15 s — proceeding',
            ),
        );

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

        // Showcase blocks are lazy-rendered via IntersectionObserver and
        // not present in the initial DOM in Apify headless. Extracted in a
        // separate handler pass after the bank-offer scroll (which brings the
        // showcase area into view). Placeholder keeps the returned shape
        // schema-complete; overwritten by the handler after extraction.
        const features: string[] = [];

        // ── SPECIFICATIONS ───────────────────────────────────────────
        // Filled by a SECOND pass in the handler below (after activating
        // the Specifications tab, which lazy-renders the table). Left empty
        // here so the initial-DOM pass never emits a partial spec set.
        const specifications: Record<string, string> = {};

        // ── OFFERS (summary tier) ────────────────────────────────────
        // Product-specific offer summaries that are already on the initial
        // buybox — no modal, no click, ~0 latency. Each item is matched by
        // a PRECISE, buybox-only text pattern (not a whole-page scan), so
        // the recommendation carousel ("₹X with Bank offer") and cross-sell
        // coupons (Mixer Grinders / Air fryer) never leak in. The detailed
        // per-bank list lives behind a click + client API and is out of
        // scope here (a later, separately-validated step). Validated live on
        // the ASUS PDP (2026-08): exactly the 4 product-specific summaries,
        // zero recommendation/cross-sell contamination.
        // Captured here so dealIntelligence (below) reuses the SAME validated,
        // buybox-scoped values — single source of truth, no re-scan.
        let bankSummaryText: string | null = null;
        let productCouponText: string | null = null;
        const offerTexts: string[] = [];
        {
            const seenOffer = new Set<string>();
            const pushOffer = (s: string): void => {
                const t = s.replace(/\s+/g, ' ').replace(/(offers)(₹)/i, '$1 $2').trim();
                if (t && !seenOffer.has(t)) {
                    seenOffer.add(t);
                    offerTexts.push(t);
                }
            };
            const ownTextOf = (el: Element): string =>
                Array.from(el.childNodes)
                    .filter((n) => n.nodeType === 3)
                    .map((n) => n.textContent || '')
                    .join('')
                    .trim();

            // 1) Bank offers summary: "Bank offers ₹3,250 off". Buybox only —
            //    recommendation tiles read "₹X with Bank offer" and never match.
            for (const el of Array.from(document.querySelectorAll('div, span'))) {
                const t = (el.textContent || '')
                    .replace(/\s+/g, ' ')
                    .replace(/(offers)(₹)/i, '$1 $2')
                    .trim();
                if (/^Bank offers ₹[\d,]+ off$/i.test(t)) {
                    bankSummaryText = t;
                    pushOffer(t);
                    break;
                }
            }

            // 2) No Cost EMI teaser: "No Cost EMI* | Unlock ₹1 lakh".
            for (const el of Array.from(document.querySelectorAll('div, span'))) {
                const t = ownTextOf(el);
                if (/^No Cost EMI.*Unlock/i.test(t) && t.length < 60) {
                    pushOffer(t);
                    break;
                }
            }

            // 3) Exchange offer, with its cap when present. "Up to ₹X" is
            //    unique to the exchange block on the PDP (validated), so
            //    attaching it is unambiguous; omit it if absent (no guessing).
            const exchangeEl = Array.from(document.querySelectorAll('div, span')).find(
                (e) => /^Exchange offer$/i.test(ownTextOf(e)),
            );
            if (exchangeEl) {
                let cap: string | null = null;
                let p: Element | null = exchangeEl;
                for (let i = 0; i < 6 && p && !cap; i++) {
                    const m = (p.textContent || '').match(/Up to ₹[\d,]+/);
                    if (m) cap = m[0];
                    p = p.parentElement;
                }
                pushOffer(cap ? `Exchange offer (${cap})` : 'Exchange offer');
            }

            // 4) Product coupon, brand-filtered. Flipkart shows cross-sell
            //    coupons alongside the product coupon; only a coupon naming
            //    THIS product's brand is product-specific, so we keep just
            //    those and drop the rest (precision over recall).
            const brandLc = typeof brand === 'string' ? brand.toLowerCase() : '';
            if (brandLc) {
                for (const el of Array.from(document.querySelectorAll('div, span'))) {
                    const t = ownTextOf(el);
                    if (
                        /Unlock .+ coupon.*(₹[\d,]+|\d+%) off/i.test(t) &&
                        t.length < 70 &&
                        t.toLowerCase().includes(brandLc)
                    ) {
                        if (productCouponText === null) productCouponText = t;
                        pushOffer(t);
                    }
                }
            }
        }

        // ── DEAL INTELLIGENCE (buybox-scoped, factual only) ──────────
        // Label-anchored to the product buybox (never a global scan, never
        // "first/largest ₹"). Every value is exactly what THIS session
        // renders — dynamic (pincode / session / default EMI tenure), so
        // absent fields are null, never inferred or hardcoded. Downstream
        // math (effective price, best offer, exchange-adjusted price) is
        // Shopigo's job, not the Actor's. Validated live on the ASUS PDP.
        const dealIntelligence = (() => {
            const toNum = (s: string | null | undefined): number | null => {
                if (!s) return null;
                const n = Number(String(s).replace(/[^\d]/g, ''));
                return Number.isFinite(n) ? n : null;
            };
            const ownTextOf = (el: Element): string =>
                Array.from(el.childNodes)
                    .filter((n) => n.nodeType === 3)
                    .map((n) => n.textContent || '')
                    .join('')
                    .trim();
            const findByOwn = (re: RegExp): Element | null =>
                Array.from(document.querySelectorAll('div, span')).find((e) =>
                    re.test(ownTextOf(e)),
                ) || null;

            // priceFee: "+₹306 Protect Promise Fee"
            let priceFee: number | null = null;
            {
                const el = findByOwn(/Protect Promise Fee/i);
                if (el) priceFee = toNum((ownTextOf(el).match(/₹[\d,]+/) || [])[0]);
            }

            // lowestPriceForYou: "₹61,740 Lowest price for you" (value precedes label)
            let lowestPriceForYou: number | null = null;
            {
                const el = findByOwn(/^Lowest price for you$/i);
                let p: Element | null = el;
                for (let i = 0; i < 3 && p && lowestPriceForYou === null; i++) {
                    const m = (p.textContent || '').match(/₹([\d,]+)\s*Lowest price for you/i);
                    if (m) lowestPriceForYou = toNum(m[1]);
                    p = p.parentElement;
                }
            }

            // emi: "₹5,745 x 12m" + "Pay ₹68,940" (extract as rendered, no arithmetic)
            let emi: {
                monthly: number | null;
                tenureMonths: number | null;
                payAmount: number | null;
            } | null = null;
            {
                const el = Array.from(document.querySelectorAll('div, span')).find((e) =>
                    /^₹[\d,]+ x \d+m$/i.test(ownTextOf(e)),
                );
                if (el) {
                    const mm = ownTextOf(el).match(/₹([\d,]+) x (\d+)m/i);
                    let payAmount: number | null = null;
                    let p: Element | null = el;
                    for (let i = 0; i < 3 && p && payAmount === null; i++) {
                        const pm = (p.textContent || '').match(/Pay ₹([\d,]+)/i);
                        if (pm) payAmount = toNum(pm[1]);
                        p = p.parentElement;
                    }
                    emi = {
                        monthly: mm ? toNum(mm[1]) : null,
                        tenureMonths: mm ? Number(mm[2]) : null,
                        payAmount,
                    };
                }
            }

            // exchange: "Exchange offer" → "Up to ₹X" (≤6 ancestors, unique on
            // page) + "extra ₹Y off" when present. Value is session/pincode
            // dependent — extract what renders, never hardcode.
            let exchange: { maxAmount: number | null; bonusAmount: number | null } | null = null;
            {
                const el = findByOwn(/^Exchange offer$/i);
                if (el) {
                    let maxAmount: number | null = null;
                    let bonusAmount: number | null = null;
                    let p: Element | null = el;
                    for (let i = 0; i < 6 && p && (maxAmount === null || bonusAmount === null); i++) {
                        const t = p.textContent || '';
                        if (maxAmount === null) {
                            const m = t.match(/Up to ₹([\d,]+)/i);
                            if (m) maxAmount = toNum(m[1]);
                        }
                        if (bonusAmount === null) {
                            const b = t.match(/extra ₹([\d,]+) off/i);
                            if (b) bonusAmount = toNum(b[1]);
                        }
                        p = p.parentElement;
                    }
                    exchange = { maxAmount, bonusAmount };
                }
            }

            // bankOfferSummary + productCoupon: reuse the already-validated,
            // buybox-scoped values captured in the offers pass above.
            const productCoupon = productCouponText
                ? {
                      text: productCouponText,
                      amount: toNum((productCouponText.match(/₹([\d,]+)/) || [])[1]),
                  }
                : null;

            return {
                priceFee,
                lowestPriceForYou,
                emi,
                exchange,
                bankOfferSummary: bankSummaryText,
                // Populated by the dedicated bank-offers pass in the handler
                // below (the individual cards lazy-render only once the section
                // is scrolled into view, so they cannot be read in this
                // initial-DOM evaluate). Empty until then — never fabricated.
                bankOffers: [] as Array<{
                    bankName: string;
                    amount: number;
                    paymentMethod: string;
                    isCashback: boolean;
                    isBestValue: boolean;
                }>,
                productCoupon,
            };
        })();

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
            dealIntelligence,
            url: window.location.href,
            scrapedAt: new Date().toISOString(),
        };
        // Pass the FINAL redirected URL (page.url() → request.loadedUrl →
        // original) so pid extraction never depends on the short input URL.
    }, page.url() || request.loadedUrl || request.url);

    // ── BANK OFFERS (individual cards) ───────────────────────────────
    // The buybox "Bank offers" carousel lazy-renders its individual cards
    // ONLY once the section enters the viewport (IntersectionObserver).
    // Verified live on the ASUS PDP (2026-08): at scrollY=0 the cards never
    // appear (0 cards after 34 s); after the section is scrolled into view
    // they render within a few hundred ms. So we scroll the section into view
    // with a NATIVE Playwright locator (a real browser scroll drives React's
    // observer reliably), then bounded-poll for the cards and extract.
    //
    // Extraction is anchored: "Bank offers" label → the offer-card section →
    // one card per exact "Apply" leaf. Verified live: "Apply" as exact
    // own-text appears on EXACTLY the bank-offer cards (5/5) and nowhere else
    // on the page, so this is inherently contamination-proof. Recommendation
    // tiles read "₹X with Bank offer" (never a bare "Apply") and are excluded
    // structurally — no global ₹ scan. Fields are read from each card's
    // ordered leaf nodes; a card missing amount/bank/payment is skipped, never
    // fabricated. Session-dynamic values (banks, amounts, count) are extracted
    // as rendered, never hardcoded. Validated live: 5 offers, 0 contamination,
    // 0 duplicates.
    const bankStart = Date.now();
    try {
        // Native Playwright scroll — exact-text match on the buybox label.
        await page
            .getByText('Bank offers', { exact: true })
            .first()
            .scrollIntoViewIfNeeded({ timeout: 5_000 });
    } catch {
        // Best-effort: if the locator isn't present (or in browser-free unit
        // tests), the in-evaluate scroll + bounded poll below is the fallback.
    }

    const bankOffers = await page.evaluate(async () => {
        const ownTextOf = (el: Element): string =>
            Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent || '')
                .join('')
                .trim();
        const toNum = (s: string | null | undefined): number | null => {
            if (!s) return null;
            const n = Number(String(s).replace(/[^\d]/g, ''));
            return Number.isFinite(n) ? n : null;
        };
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const findLabel = (): Element | null =>
            Array.from(document.querySelectorAll('div, span')).find((e) =>
                /^Bank offers$/i.test(ownTextOf(e)),
            ) || null;
        const countApply = (): number =>
            Array.from(document.querySelectorAll('*')).filter((e) =>
                /^Apply$/i.test(ownTextOf(e)),
            ).length;

        // Fallback scroll (belt-and-suspenders with the native scroll above) +
        // bounded wait for the lazy-rendered cards (≤3 s — evidence-based, not
        // an arbitrary sleep). Bails the moment the first card appears.
        const label0 = findLabel();
        if (label0) label0.scrollIntoView({ block: 'center' });
        for (let i = 0; i < 20 && countApply() === 0; i++) await sleep(150);

        // Semantic anchor: the buybox "Bank offers" label.
        const label = findLabel();
        if (!label) return [];

        // Climb to the smallest ancestor that already holds offer cards
        // (an "Apply" leaf AND a "₹X off"). Bounded.
        let section: Element | null = null;
        let p: Element | null = label;
        for (let lvl = 0; lvl < 9 && p; lvl++) {
            const hasApply = Array.from(p.querySelectorAll('*')).some((e) =>
                /^Apply$/i.test(ownTextOf(e)),
            );
            if (hasApply && /₹[\d,]+\s*off/i.test(p.textContent || '')) {
                section = p;
                break;
            }
            p = p.parentElement;
        }
        if (!section) return [];

        // One card per "Apply" leaf; climb to the self-contained card row
        // (exactly one "₹X off" + a payment method + short text).
        const applies = Array.from(section.querySelectorAll('*')).filter((e) =>
            /^Apply$/i.test(ownTextOf(e)),
        );
        const seen = new Set<string>();
        const out: Array<{
            bankName: string;
            amount: number;
            paymentMethod: string;
            isCashback: boolean;
            isBestValue: boolean;
        }> = [];
        // Payment instruments Flipkart tags on buybox offer cards. UPI is a
        // first-class method (e.g. the "CRED ₹100 off • UPI" card), not a bank
        // card — so the abstraction is payment offers, not only bank offers.
        // Kept as an open alternation (not a closed enum) so a new Flipkart
        // method is a one-token addition, never a schema change.
        const payRe = /(Credit Card|Debit Card|UPI|EMI|Net ?Banking|Wallet)/i;
        for (const a of applies) {
            let card: Element | null = null;
            let q: Element | null = a;
            for (let lvl = 0; lvl < 8 && q; lvl++) {
                const t = (q.textContent || '').replace(/\s+/g, ' ').trim();
                const amt = t.match(/₹[\d,]+\s*off/gi) || [];
                if (amt.length === 1 && /Apply/i.test(t) && payRe.test(t) && t.length < 100) {
                    card = q;
                }
                q = q.parentElement;
            }
            if (!card) continue;

            // Read fields from the card's ordered leaf nodes.
            const leaves = Array.from(card.querySelectorAll('*'))
                .filter((e) => e.children.length === 0 && (e.textContent || '').trim())
                .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim());
            const amountLeaf = leaves.find((t) => /^₹[\d,]+\s*off$/i.test(t));
            const payLeaf = leaves.find((t) => payRe.test(t));
            const isBestValue = leaves.some((t) => /^Best value for you$/i.test(t));
            const bankLeaf = leaves.find(
                (t) =>
                    t !== amountLeaf &&
                    t !== payLeaf &&
                    !/^Apply$/i.test(t) &&
                    !/^Best value for you$/i.test(t) &&
                    t.length > 0 &&
                    t.length < 40,
            );
            const amount = toNum(amountLeaf);
            if (amount === null || !bankLeaf || !payLeaf) continue; // require core fields

            const paymentMethod = payLeaf.split('•')[0].trim();
            const isCashback = /cashback/i.test(payLeaf);
            const key = `${bankLeaf}|${amount}|${paymentMethod}`;
            if (seen.has(key)) continue; // drop exact duplicates
            seen.add(key);
            out.push({ bankName: bankLeaf, amount, paymentMethod, isCashback, isBestValue });
        }
        return out;
    });
    const bankMs = Date.now() - bankStart;
    if (product.dealIntelligence && Array.isArray(bankOffers)) {
        product.dealIntelligence.bankOffers = bankOffers;
    }
    log.info(
        `[flipkart] bankOffers=${Array.isArray(bankOffers) ? bankOffers.length : 0} in ${bankMs}ms`,
    );

    // ── FEATURES (showcase blocks) ──────────────────────────────────────
    // Must run BEFORE the Specifications tab is clicked — clicking the tab
    // causes React to unmount Showcase and mount the spec table, making
    // feature extraction impossible afterward.
    // Flipkart's scroll container is div.lQLKCP (not the window).
    // scrollIntoView({block:'center'}) on the Specifications heading sets
    // lQLKCP.scrollTop ≈ 1572, making the visible range 1572–2227 which
    // covers the Showcase content area at containerRelativeY ≈ 1934 and
    // fires the IntersectionObserver that renders the Showcase blocks.
    try {
        await page
            .getByText('Specifications', { exact: true })
            .first()
            .evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }), undefined, {
                // Bounded: if the tab text is absent/slow in headless, fail fast
                // instead of blocking on the 30 s default locator timeout.
                timeout: 5_000,
            });
        await page.waitForTimeout(250);
    } catch {
        // absent in unit-test stubs; extraction falls back to whatever is in DOM
    }
    const featStart = Date.now();
    const features = await page.evaluate(async () => {
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
        const result: string[] = [];
        const seenFeature = new Set<string>();
        Array.from(document.querySelectorAll('div')).forEach((d) => {
            const kids = Array.from(d.children);
            if (kids.length !== 2) return;
            if (kids[0].children.length !== 0) return;
            const t = (kids[0].textContent || '').replace(/\s+/g, ' ').trim();
            const desc = (kids[1].textContent || '')
                .replace(/\s+/g, ' ')
                .replace(/\.?\.\.\s*more$/i, '')
                .replace(/\s*more$/i, '')
                .trim();
            if (t.length < 3 || t.length > 45) return;
            if (/[:|₹]/.test(t) || /^\d/.test(t)) return;
            const words = desc.split(' ').filter(Boolean);
            if (desc.length < 45 || words.length < 7) return;
            if ((desc.match(/\b[a-z]{2,}\b/g) || []).length < 5) return;
            if (featureHasNestedRow(kids[1])) return;
            if ((desc.match(/[a-z][A-Z]/g) || []).length > 2) return;
            if (seenFeature.has(t)) return;
            seenFeature.add(t);
            result.push(`${t}: ${desc}`);
        });
        return result;
    });
    const featMs = Date.now() - featStart;
    product.features = Array.isArray(features) ? features : product.features;
    log.info(`[flipkart] features=${product.features.length} in ${featMs}ms`);

    // ── SPECIFICATIONS (second pass) ─────────────────────────────────
    // Flipkart lazy-renders the spec table only once the Specifications
    // tab is activated. A native Playwright click centers the tab in the
    // lQLKCP scroll container (scrollTop ≈ 1572, visible range 1572–2227)
    // AND dispatches a trusted pointer event that fires React's synthetic
    // onClick. scrollIntoViewIfNeeded (prior approach) did minimum scroll
    // only — the content area landed 35 px outside lQLKCP's viewport so
    // the spec table never entered view and JS-level click() was ignored.
    // If the tab never renders (unit-test stubs), the poll times out and
    // the guard below returns {} — showcase data never contaminates specs.
    try {
        // Bounded: a native click retries actionability checks up to Playwright's
        // 30 s default; in headless the tab can be unactionable and hang the whole
        // requestHandler. Cap at 5 s — a healthy click resolves in <1 s. On miss it
        // throws → caught here → the rowReady() guard below returns {} gracefully.
        await page.getByText('Specifications', { exact: true }).first().click({ timeout: 5_000 });
    } catch {
        // absent in unit-test stubs, or the tab was not clickable in time
    }

    const specifications = await page.evaluate(async () => {
        const ownText = (el: Element): string =>
            Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent || '')
                .join('')
                .trim();
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // Scoped readiness check: real spec values are short technical terms
        // (≤60 chars); showcase prose descriptions are long and excluded.
        // Nav/buybox rows account for ~15 matches before the spec table
        // renders; the threshold of 20 requires the spec table to be live
        // (which adds ~49 rows). Prevents early exit on showcase/nav noise.
        const rowReady = (): boolean => {
            const shortValueRow = (d: Element): boolean => {
                const k = d.children[0];
                const v = d.children[1];
                if (!k || !v || d.children.length > 3) return false;
                if (k.children.length !== 0) return false;
                const kText = (k.textContent || '').replace(/\s+/g, ' ').trim();
                const vText = (v.textContent || '').replace(/\s+/g, ' ').trim();
                return (
                    kText.length >= 2 &&
                    kText.length <= 40 &&
                    vText.length >= 1 &&
                    vText.length <= 60 &&
                    kText !== vText
                );
            };
            return (
                Array.from(document.querySelectorAll('div')).filter(shortValueRow).length >= 20
            );
        };
        for (let i = 0; i < 15 && !rowReady(); i++) await sleep(200);
        // Guard: if the spec table still hasn't rendered, return empty rather
        // than letting bestAnc pick up the Showcase blocks as "best" ancestor.
        if (!rowReady()) return {};

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
