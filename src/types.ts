/**
 * One individual bank offer card from the Flipkart buybox "Bank offers"
 * carousel. Factual only, read from the rendered card's own leaf nodes.
 * The set of banks, amounts and even the count are session/pincode dependent
 * and are extracted exactly as rendered — never hardcoded. Shopigo AI decides
 * the best card / effective price downstream; the Actor only reports.
 */
export interface BankOffer {
    /** Bank / card program label, e.g. "Flipkart Axis", "IndusInd", "RBL". */
    bankName: string;
    /** Instant discount amount in ₹ (the "₹X off" on the card). */
    amount: number;
    /** Payment instrument, e.g. "Credit Card" (cashback stripped out). */
    paymentMethod: string;
    /** True when the card's payment line is flagged "• Cashback". */
    isCashback: boolean;
    /** True for the card Flipkart tags "Best value for you". */
    isBestValue: boolean;
}

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
    /**
     * Individual bank offer cards. Additive to bankOfferSummary (which is
     * unchanged). Empty array when the carousel renders no cards for this
     * session — never null-vs-[] guessing, never fabricated.
     */
    bankOffers: BankOffer[];
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
    variants: Array<{
        text: string;
        value: string | null;
        // Additive, optional, backward-compatible. Populated by the Flipkart
        // handler for real product variants (e.g. Storage/RAM options): price,
        // MRP, selected state, the variant's Flipkart pid and canonical URL.
        // Other merchants keep emitting only { text, value } and omit these, so
        // existing consumers and schemas are unaffected.
        price?: number | null;
        mrp?: number | null;
        selected?: boolean;
        pid?: string | null;
        url?: string | null;
    }>;
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
