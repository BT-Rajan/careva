import { InvoiceStatus } from '@prisma/client';
import { TRANSITIONS, assertValidInvoiceTransition, assertValidInvoiceTransitionShape } from '../../app/modules/invoice/invoice-lifecycle';
import { assertExhaustiveTransitionGraph } from './stateMachineTestHelpers';

const ALL_STATUSES: InvoiceStatus[] = ['ISSUED', 'PAID', 'VOID'];

describe('invoice-lifecycle: assertValidInvoiceTransition (human-actor path)', () => {
    describe('the one human-triggerable edge: admin manual void', () => {
        it('admin can void an ISSUED invoice', () => {
            expect(() => assertValidInvoiceTransition('ISSUED', 'VOID', 'admin')).not.toThrow();
        });
        it('admin can void a PAID invoice', () => {
            expect(() => assertValidInvoiceTransition('PAID', 'VOID', 'admin')).not.toThrow();
        });
        it('doctor cannot void an invoice — admin only', () => {
            expect(() => assertValidInvoiceTransition('ISSUED', 'VOID', 'doctor')).toThrow();
        });
        it('patient cannot void an invoice — admin only', () => {
            expect(() => assertValidInvoiceTransition('ISSUED', 'VOID', 'patient')).toThrow();
        });
    });

    describe('ISSUED -> PAID is system-only: no human actor can trigger it via this function', () => {
        it('admin cannot mark an invoice PAID directly', () => {
            expect(() => assertValidInvoiceTransition('ISSUED', 'PAID', 'admin')).toThrow();
        });
        it('doctor cannot mark an invoice PAID directly', () => {
            expect(() => assertValidInvoiceTransition('ISSUED', 'PAID', 'doctor')).toThrow();
        });
        it('patient cannot mark an invoice PAID directly', () => {
            expect(() => assertValidInvoiceTransition('ISSUED', 'PAID', 'patient')).toThrow();
        });
    });

    describe('VOID is fully terminal', () => {
        it('has no legal outgoing transition', () => {
            expect(TRANSITIONS.VOID).toEqual([]);
        });
    });

    assertExhaustiveTransitionGraph(ALL_STATUSES, TRANSITIONS, assertValidInvoiceTransition, ['admin']);
});

describe('invoice-lifecycle: assertValidInvoiceTransitionShape (system-only path)', () => {
    it('allows ISSUED -> PAID with no actor check at all — this is what payment.service.ts calls', () => {
        expect(() => assertValidInvoiceTransitionShape('ISSUED', 'PAID')).not.toThrow();
    });
    it('allows ISSUED -> VOID (used by the automatic cancellation/refund void paths)', () => {
        expect(() => assertValidInvoiceTransitionShape('ISSUED', 'VOID')).not.toThrow();
    });
    it('still rejects a genuinely illegal shape — PAID -> ISSUED', () => {
        expect(() => assertValidInvoiceTransitionShape('PAID', 'ISSUED')).toThrow();
    });
    it('still rejects any transition out of VOID', () => {
        expect(() => assertValidInvoiceTransitionShape('VOID', 'ISSUED')).toThrow();
        expect(() => assertValidInvoiceTransitionShape('VOID', 'PAID')).toThrow();
    });
});
