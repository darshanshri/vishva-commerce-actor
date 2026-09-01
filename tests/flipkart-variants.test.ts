import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Flipkart VARIANT extraction.
 *
 * Like routing.test.ts and flipkart-payment-offers.test.ts, this asserts the
 * SHIPPED artifact (dist/) — the extraction runs inside a page.evaluate()
 * browser closure and cannot be imported, so we (a) prove the shipped handler
 * contains the exact anchoring/parsing patterns, and (b) prove those patterns
 * classify the REAL Flipkart DOM correctly, using fixtures captured live from
 * the realme P4s 5G PDP (2026-09):
 *
 *   Variant:  128 GB + 8 GB   ↓29% 48,999 ₹34,999   pid MOBHPBHATYTBGZXN (selected)
 *             256 GB + 12 GB  ↓31% 60,999 ₹41,999   pid MOBHPBHAEHZXGFCV
 *             256 GB + 8 GB   ↓31% 54,999 ₹37,999   pid MOBHPBHAGEJZ4KWF
 *
 * The DOM-structural parts that node cannot reproduce (computed line-through
 * MRP detection, and section-scoping via the "Variant:" label ancestor) are
 * validated by the live browser probe, not here — this file proves the
 * pure text/href parsing the shipped handler performs on that structure.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shipped = readFileSync(resolve(here, '../dist/merchants/flipkart.js'), 'utf8');

// Real option link texts + hrefs, exactly as rendered on the live PDP.
const PAGE_PID = 'MOBHPBHATYTBGZXN';
const FIXTURES = [
    {
        linkText: '128 GB + 8 GB ↓29%48,999₹34,999',
        href: '/realme-p4s-5g-titanium-gray-128-gb/p/itmcb2e7e552a5ef?pid=MOBHPBHATYTBGZXN&marketplace=FLIPKART',
        label: '128 GB + 8 GB',
        pid: 'MOBHPBHATYTBGZXN',
        price: 34999,
        mrp: 48999,
    },
    {
        linkText: '256 GB + 12 GB ↓31%60,999₹41,999',
        href: '/realme-p4s-5g-titanium-gray-256-gb/p/itmcb2e7e552a5ef?pid=MOBHPBHAEHZXGFCV&marketplace=FLIPKART',
        label: '256 GB + 12 GB',
        pid: 'MOBHPBHAEHZXGFCV',
        price: 41999,
        mrp: 60999,
    },
    {
        linkText: '256 GB + 8 GB ↓31%54,999₹37,999',
        href: '/realme-p4s-5g-titanium-gray-256-gb/p/itmcb2e7e552a5ef?pid=MOBHPBHAGEJZ4KWF&marketplace=FLIPKART',
        label: '256 GB + 8 GB',
        pid: 'MOBHPBHAGEJZ4KWF',
        price: 37999,
        mrp: 54999,
    },
];

describe('Flipkart variant extraction (shipped dist)', () => {
    it('the shipped handler anchors on the attribute-selector label', () => {
        // The variant section is found via the "Variant:"/"Storage"/"Size" label.
        expect(shipped).toContain('(Variant|Storage|Size)');
    });

    it('the shipped handler scopes to PDP option links, not a page-wide scan', () => {
        // Options are read from <a href*="/p/itm"> inside the variant section.
        expect(shipped).toContain('a[href*="/p/itm"]');
    });

    it('the shipped handler carries the config-leaf pattern', () => {
        // Storage/RAM combo classifier, e.g. "128 GB + 8 GB".
        expect(shipped).toContain('GB(\\s*\\+\\s*\\d{1,2}\\s*GB)');
    });

    // Reconstruct the exact patterns the shipped handler uses.
    const configLeaf = /^\d{2,3}\s*GB(\s*\+\s*\d{1,2}\s*GB)?$/i;
    const pidRe = /[?&]pid=([A-Z0-9]+)/i;
    const priceRe = /₹\s*([\d,]+)/;
    const toNum = (s: string) => Number(s.replace(/[^\d]/g, ''));

    it.each(FIXTURES)('classifies "$label" as a real config option', ({ label }) => {
        expect(configLeaf.test(label)).toBe(true);
    });

    it('rejects non-variant / recommendation-style leaves', () => {
        expect(configLeaf.test('Add to Cart')).toBe(false);
        expect(configLeaf.test('₹34,999')).toBe(false);
        expect(configLeaf.test('Samsung Galaxy M15')).toBe(false);
        // A stray "8 GB RAM" spec phrase is not a bare storage/RAM combo option.
        expect(configLeaf.test('8 GB RAM')).toBe(false);
    });

    it.each(FIXTURES)('extracts pid/price for "$label"', ({ linkText, href, pid, price }) => {
        expect((href.match(pidRe) || [])[1]).toBe(pid);
        const pm = linkText.match(priceRe);
        expect(pm).not.toBeNull();
        expect(toNum(pm![1])).toBe(price);
    });

    it('yields three distinct variant pids', () => {
        const pids = FIXTURES.map((f) => (f.href.match(pidRe) || [])[1]);
        expect(new Set(pids).size).toBe(3);
    });

    it('marks exactly the on-page pid as the selected variant', () => {
        const selected = FIXTURES.filter((f) => (f.href.match(pidRe) || [])[1] === PAGE_PID);
        expect(selected).toHaveLength(1);
        expect(selected[0].label).toBe('128 GB + 8 GB');
    });
});
