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
    url: string;
    scrapedAt: string;
}

export type MerchantId = 'amazon' | 'flipkart' | 'myntra' | 'nykaa' | 'unknown';
