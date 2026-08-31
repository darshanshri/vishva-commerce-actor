/**
 * Buybox deal intelligence (Flipkart).
 *
 * Factual, buybox-scoped values exactly as the merchant renders them for the
 * current session — they are dynamic (pincode / session / default EMI tenure
 * dependent). Any field the session does not render is null; never inferred,
 * never hardcoded. Shopigo AI performs the downstream calculations (effective
 * price, best offer, exchange-adjusted price, etc.) — not the Actor.
 */
export interface DealIntelligence {
    priceFee: number | null;
    lowestPriceForYou: number | null;
    emi: {
        monthly: number | null;
        tenureMonths: number | null;
        payAmount: number | null;
    } | null;
    exchange: {
        maxAmount: number | null;
        bonusAmount: number | null;
    } | null;
    bankOfferSummary: string | null;
    productCoupon: {
        text: string | null;
        amount: number | null;
    } | null;
}

/**
 * Normalized product data schema.
 *
 * All four merchants (Amazon, Flipkart, Myntra, Nykaa) produce this shape.
 * Null / empty values are acceptable when the source does not expose the field.
 * Never fabricate values.
 */
export interface ProductData {
    merchant: string;
    productId: string | null;
    title: string | null;
    brand: string | null;
    price: number | null;
    priceText: string | null;
    mrp: number | null;
    mrpText: string | null;
    rating: number | null;
    reviewCount: number | null;
    availability: string | null;
    seller: string | null;
    features: string[];
    specifications: Record<string, string>;
    variants: Array<{ text: string; value: string | null }>;
    images: string[];
    offers: string[];
    /**
     * Optional, additive. Populated by the Flipkart handler only; other
     * merchants omit it. Backward-compatible — existing consumers ignore it.
     */
    dealIntelligence?: DealIntelligence | null;
    url: string;
    scrapedAt: string;
}

export type MerchantId = 'amazon' | 'flipkart' | 'myntra' | 'nykaa' | 'unknown';
