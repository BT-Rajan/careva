/**
 * Pass 7 — Payment System. Selects the correct gateway adapter for a given currency.
 * INR → Razorpay (India), KWD → Telr (Kuwait). Adding a third market means adding one
 * case here plus one adapter class — nothing else in the payment/booking flow changes.
 */
import { Currency } from '@prisma/client';
import { PaymentProviderAdapter } from './payment-provider.interface';
import { RazorpayProviderAdapter } from './razorpay.provider';
import { TelrProviderAdapter } from './telr.provider';

const razorpayAdapter = new RazorpayProviderAdapter();
const telrAdapter = new TelrProviderAdapter();

export const getProviderForCurrency = (currency: Currency): PaymentProviderAdapter => {
    switch (currency) {
        case 'INR':
            return razorpayAdapter;
        case 'KWD':
            return telrAdapter;
        default:
            throw new Error(`No payment provider configured for currency: ${currency}`);
    }
};

export const getProviderByName = (name: 'razorpay' | 'telr'): PaymentProviderAdapter => {
    return name === 'razorpay' ? razorpayAdapter : telrAdapter;
};
