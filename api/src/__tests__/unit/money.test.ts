import { toMinorUnits, fromMinorUnits, formatMinorUnitsAsDecimalString } from '../../shared/money';

describe('money: toMinorUnits', () => {
    it('converts a 2-decimal INR amount correctly', () => {
        expect(toMinorUnits(60.5, 'INR')).toBe(6050);
    });
    it('converts a 3-decimal KWD amount correctly — the classic off-by-10x risk this file exists to prevent', () => {
        expect(toMinorUnits(7.5, 'KWD')).toBe(7500);
    });
    it('accepts a string amount (Doctor.price is stored as a string)', () => {
        expect(toMinorUnits('60.50', 'INR')).toBe(6050);
    });
    it('rounds rather than truncates — avoids losing a paisa/fils to float representation error', () => {
        // 60.5 * 1000 can land on 60499.999999999996 in raw JS floating point.
        expect(toMinorUnits(60.5, 'KWD')).toBe(60500);
    });
    it('rejects a negative amount', () => {
        expect(() => toMinorUnits(-5, 'INR')).toThrow();
    });
    it('rejects a non-numeric string', () => {
        expect(() => toMinorUnits('not-a-number', 'INR')).toThrow();
    });
    it('rejects NaN/Infinity', () => {
        expect(() => toMinorUnits(NaN, 'INR')).toThrow();
        expect(() => toMinorUnits(Infinity, 'INR')).toThrow();
    });
    it('accepts zero as a valid amount', () => {
        expect(toMinorUnits(0, 'INR')).toBe(0);
    });
});

describe('money: fromMinorUnits', () => {
    it('converts INR minor units back to a decimal', () => {
        expect(fromMinorUnits(6050, 'INR')).toBe(60.5);
    });
    it('converts KWD minor units back to a decimal using the 1000 multiplier, not 100', () => {
        expect(fromMinorUnits(7500, 'KWD')).toBe(7.5);
    });
    it('round-trips through toMinorUnits without drift for a representative set of amounts', () => {
        for (const amount of [0, 1, 9.99, 60.5, 1000.01, 7.5]) {
            expect(fromMinorUnits(toMinorUnits(amount, 'INR'), 'INR')).toBeCloseTo(amount, 5);
            expect(fromMinorUnits(toMinorUnits(amount, 'KWD'), 'KWD')).toBeCloseTo(amount, 5);
        }
    });
});

describe('money: formatMinorUnitsAsDecimalString', () => {
    it('formats INR with exactly 2 decimal places', () => {
        expect(formatMinorUnitsAsDecimalString(6050, 'INR')).toBe('60.50');
    });
    it('formats KWD with exactly 3 decimal places, not 2', () => {
        expect(formatMinorUnitsAsDecimalString(7500, 'KWD')).toBe('7.500');
    });
    it('pads a whole-number amount to the currency\'s full decimal width', () => {
        expect(formatMinorUnitsAsDecimalString(10000, 'KWD')).toBe('10.000');
    });
});
