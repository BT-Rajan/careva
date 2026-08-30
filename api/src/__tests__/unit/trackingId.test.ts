import { generateTrackingId } from '../../shared/trackingId';

describe('trackingId: generateTrackingId', () => {
    it('starts with the CV brand prefix', () => {
        expect(generateTrackingId().startsWith('CV')).toBe(true);
    });

    it('is exactly 14 characters — CV + 12 hex characters', () => {
        expect(generateTrackingId()).toHaveLength(14);
    });

    it('the part after CV is uppercase hex only — no digits/letters outside 0-9A-F', () => {
        const id = generateTrackingId();
        expect(id.slice(2)).toMatch(/^[0-9A-F]{12}$/);
    });

    it('produces a different value on every call — this is the actual security property that matters (Pass 15: the old name+date+counter format was enumerable; this one is not)', () => {
        const ids = new Set(Array.from({ length: 1000 }, () => generateTrackingId()));
        expect(ids.size).toBe(1000);
    });
});
