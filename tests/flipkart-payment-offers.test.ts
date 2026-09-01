import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Flipkart buybox PAYMENT-OFFER recognition.
 *
 * The handler classifies each buybox offer card by matching the card's text
 * against a single payment-method alternation (`payRe`). A method missing from
 * that alternation means every card using it is silently dropped — the exact
 * bug that lost the real "CRED  ₹100 off  •  UPI" card, because UPI was not a
 * recognized method.
 *
 * Like routing.test.ts, this asserts the SHIPPED artifact (dist/), not src —
 * the regex runs inside a page.evaluate() browser closure and cannot be
 * imported, so we extract the actual shipped pattern from the compiled handler
 * and prove ITS behavior. If a future edit drops UPI (or any existing method)
 * from the alternation, the extracted regex stops matching and this fails.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shipped = readFileSync(resolve(here, '../dist/merchants/flipkart.js'), 'utf8');

// Pull the real payment-method alternation out of the shipped handler.
const match = shipped.match(/\/\((Credit Card\|[^/]+)\)\/i/);

describe('Flipkart buybox payment-method recognition (shipped dist)', () => {
    it('the payment-method alternation exists in the shipped handler', () => {
        expect(match).not.toBeNull();
    });

    const alternation = match ? match[1] : '';
    // Reconstruct the exact regex the handler uses, from the shipped source.
    const payRe = match ? new RegExp(`(${alternation})`, 'i') : /$^/;

    // Every method the buybox is expected to support — UPI included.
    it.each(['Credit Card', 'Debit Card', 'UPI', 'EMI', 'Net Banking', 'Wallet'])(
        'recognizes "%s" as a payment method',
        (method) => {
            expect(payRe.test(method)).toBe(true);
        },
    );

    it('recognizes a real CRED/UPI card, keeps existing card offers, and rejects a recommendation tile', () => {
        // The regressed card — must now be recognized structurally (via UPI).
        expect(payRe.test('CRED ₹100 off UPI Apply')).toBe(true);
        // Pre-existing offers must keep matching.
        expect(payRe.test('Flipkart Axis ₹3,700 off Credit Card • Cashback Apply')).toBe(true);
        // Recommendation carousel tile carries no payment method → excluded.
        expect(payRe.test('Samsung Monitor ₹4,000 with Bank offer')).toBe(false);
    });
});
