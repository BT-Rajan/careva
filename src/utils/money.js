/**
 * Pass 14 — Invoice & Financial Records.
 *
 * Frontend counterpart to api/src/shared/money.ts (Pass 7). Amounts have been stored
 * in minor units (paise/fils, not whole currency units) since Pass 7, but Pass 7's own
 * doc flagged the frontend checkout UI as explicitly not built — nothing on this side
 * was ever updated to match. BookingInvoice.jsx was still rendering `${data.totalAmount}`
 * directly, which would show a raw minor-unit integer (e.g. "$6000" for what is
 * actually 60.00 of a 2-decimal currency, and off by a factor of 10 again for KWD's
 * 3-decimal fils) — silently wrong exactly the way the backend comment for this same
 * bug class warns about. Fixed here, in the same pass that rebuilds the page this
 * bug lives on, rather than left in place while the surrounding code is rewritten
 * around it.
 */

const MINOR_UNIT_MULTIPLIER = {
    INR: 100,
    KWD: 1000,
};

const MINOR_UNIT_DECIMAL_PLACES = {
    INR: 2,
    KWD: 3,
};

const CURRENCY_SYMBOL = {
    INR: '₹',
    KWD: 'KD ',
};

/** Converts an integer minor-unit amount back into a human decimal number. */
export const fromMinorUnitsNumber = (minorAmount, currency) => {
    const multiplier = MINOR_UNIT_MULTIPLIER[currency] ?? 100;
    return (minorAmount ?? 0) / multiplier;
};

/** Formats a minor-unit amount for display, e.g. fromMinorUnits(6000, 'INR') -> "₹60.00". */
export const fromMinorUnits = (minorAmount, currency) => {
    if (minorAmount === null || minorAmount === undefined) return '—';
    const decimals = MINOR_UNIT_DECIMAL_PLACES[currency] ?? 2;
    const symbol = CURRENCY_SYMBOL[currency] ?? '';
    return `${symbol}${fromMinorUnitsNumber(minorAmount, currency).toFixed(decimals)}`;
};
