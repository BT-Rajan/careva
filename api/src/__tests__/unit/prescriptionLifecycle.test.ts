import { PrescriptionStatus } from '@prisma/client';
import { TRANSITIONS, assertValidPrescriptionTransition } from '../../app/modules/prescription/prescription-lifecycle';
import { assertExhaustiveTransitionGraph } from './stateMachineTestHelpers';

const ALL_STATUSES: PrescriptionStatus[] = ['ISSUED', 'FULFILLED', 'CORRECTED', 'ARCHIVED'];

describe('prescription-lifecycle', () => {
    describe('legal transitions succeed for their documented actors', () => {
        it('patient can self-report fulfillment ISSUED -> FULFILLED', () => {
            expect(() => assertValidPrescriptionTransition('ISSUED', 'FULFILLED', 'patient')).not.toThrow();
        });
        it('doctor can also record fulfillment ISSUED -> FULFILLED', () => {
            expect(() => assertValidPrescriptionTransition('ISSUED', 'FULFILLED', 'doctor')).not.toThrow();
        });
        it('admin can also record fulfillment ISSUED -> FULFILLED', () => {
            expect(() => assertValidPrescriptionTransition('ISSUED', 'FULFILLED', 'admin')).not.toThrow();
        });
        it('doctor can correct an ISSUED prescription', () => {
            expect(() => assertValidPrescriptionTransition('ISSUED', 'CORRECTED', 'doctor')).not.toThrow();
        });
        it('doctor can correct a FULFILLED prescription', () => {
            expect(() => assertValidPrescriptionTransition('FULFILLED', 'CORRECTED', 'doctor')).not.toThrow();
        });
        it('doctor can archive an ISSUED prescription', () => {
            expect(() => assertValidPrescriptionTransition('ISSUED', 'ARCHIVED', 'doctor')).not.toThrow();
        });
        it('doctor can archive a FULFILLED prescription', () => {
            expect(() => assertValidPrescriptionTransition('FULFILLED', 'ARCHIVED', 'doctor')).not.toThrow();
        });
    });

    describe('actor restrictions on otherwise-legal edges', () => {
        it('patient cannot correct their own prescription — clinical content is doctor/admin-only', () => {
            expect(() => assertValidPrescriptionTransition('ISSUED', 'CORRECTED', 'patient')).toThrow();
        });
        it('patient cannot archive a prescription', () => {
            expect(() => assertValidPrescriptionTransition('ISSUED', 'ARCHIVED', 'patient')).toThrow();
        });
    });

    describe('CORRECTED and ARCHIVED are both terminal by design', () => {
        it('CORRECTED has no legal outgoing transition — the corrected version, not this row, continues', () => {
            expect(TRANSITIONS.CORRECTED).toEqual([]);
        });
        it('ARCHIVED has no legal outgoing transition — no unarchive path exists', () => {
            expect(TRANSITIONS.ARCHIVED).toEqual([]);
        });
    });

    assertExhaustiveTransitionGraph(ALL_STATUSES, TRANSITIONS, assertValidPrescriptionTransition, ['admin']);
});
