/**
 * Pass 7 — Payment System.
 *
 * Both gateways (Razorpay and Telr) — and correct money handling in general — need
 * amounts as integers in the smallest unit of the currency, not floating-point decimals.
 * Floating-point currency math is a classic source of off-by-a-fraction bugs; storing
 * everything as an integer count of the smallest unit avoids that entirely.
 *
 * INR: 1 rupee = 100 paise (standard 2-decimal currency).
 * KWD: 1 dinar = 1000 fils — Kuwait's dinar is a 3-decimal-place currency, not 2. This is
 * easy to get wrong if you copy 2-decimal assumptions from an INR/USD-only integration,
 * and would silently overcharge or undercharge Kuwaiti patients by a factor of 10 if
 * mishandled.
 */
import { Currency } from "@prisma/client";

export const MINOR_UNIT_MULTIPLIER: Record<Currency, number> = {
    INR: 100,
    KWD: 1000,
};

export const MINOR_UNIT_DECIMAL_PLACES: Record<Currency, number> = {
    INR: 2,
    KWD: 3,
};

/**
 * Converts a human-entered decimal amount (e.g. Doctor.price = "60.50") into an integer
 * count of the currency's smallest unit, for storage and for sending to a gateway.
 */
export const toMinorUnits = (amount: number | string, currency: Currency): number => {
    const numeric = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (!Number.isFinite(numeric) || numeric < 0) {
        throw new Error(`Invalid amount for minor-unit conversion: ${amount}`);
    }
    // Round rather than truncate — avoids losing a fils/paisa to floating-point
    // representation error (e.g. 60.5 * 1000 can land on 60499.999999999996 in JS).
    return Math.round(numeric * MINOR_UNIT_MULTIPLIER[currency]);
};

/**
 * Converts an integer minor-unit amount back into a human-decimal number, e.g. for
 * display or for building a request field a gateway expects as a decimal string.
 */
export const fromMinorUnits = (minorAmount: number, currency: Currency): number => {
    return minorAmount / MINOR_UNIT_MULTIPLIER[currency];
};

/**
 * Formats a minor-unit amount as the fixed-decimal string some gateway APIs expect
 * (Telr's order.json wants e.g. "7.500" for KWD, "60.50" would be the INR-equivalent
 * 2-decimal shape) — decimal places are currency-specific, not a fixed "2 decimals"
 * assumption.
 */
export const formatMinorUnitsAsDecimalString = (minorAmount: number, currency: Currency): string => {
    return fromMinorUnits(minorAmount, currency).toFixed(MINOR_UNIT_DECIMAL_PLACES[currency]);
};
