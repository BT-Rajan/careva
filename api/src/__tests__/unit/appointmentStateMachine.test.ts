import { AppointmentStatus } from '@prisma/client';
import { TRANSITIONS, assertValidAppointmentTransition, assertValidAppointmentTransitionShape } from '../../app/modules/appointment/appointment-state-machine';
import { assertExhaustiveTransitionGraph } from './stateMachineTestHelpers';

const ALL_STATUSES: AppointmentStatus[] = [
    'PENDING', 'SCHEDULED', 'DECLINED', 'EXPIRED', 'COMPLETED',
    'CANCELLED_BY_PATIENT', 'CANCELLED_BY_DOCTOR', 'CANCELLED_BY_ADMIN', 'NO_SHOW',
];

describe('appointment-state-machine', () => {
    describe('legal transitions succeed for their documented actors', () => {
        it('doctor can confirm PENDING -> SCHEDULED', () => {
            expect(assertValidAppointmentTransition('PENDING', 'SCHEDULED', 'doctor')).toEqual({ from: 'PENDING', to: 'SCHEDULED' });
        });
        it('admin can confirm PENDING -> SCHEDULED', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'SCHEDULED', 'admin')).not.toThrow();
        });
        it('doctor can decline PENDING -> DECLINED', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'DECLINED', 'doctor')).not.toThrow();
        });
        it('patient can withdraw PENDING -> CANCELLED_BY_PATIENT', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'CANCELLED_BY_PATIENT', 'patient')).not.toThrow();
        });
        it('doctor can mark SCHEDULED -> COMPLETED', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'COMPLETED', 'doctor')).not.toThrow();
        });
        it('doctor can mark SCHEDULED -> NO_SHOW', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'NO_SHOW', 'doctor')).not.toThrow();
        });
        it('patient can cancel SCHEDULED -> CANCELLED_BY_PATIENT', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'CANCELLED_BY_PATIENT', 'patient')).not.toThrow();
        });
        it('doctor can cancel SCHEDULED -> CANCELLED_BY_DOCTOR', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'CANCELLED_BY_DOCTOR', 'doctor')).not.toThrow();
        });
        it('admin can cancel SCHEDULED -> CANCELLED_BY_ADMIN', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'CANCELLED_BY_ADMIN', 'admin')).not.toThrow();
        });
    });

    describe('actor restrictions on otherwise-legal edges', () => {
        it('patient cannot confirm PENDING -> SCHEDULED (only doctor/admin)', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'SCHEDULED', 'patient')).toThrow();
        });
        it('patient cannot decline PENDING -> DECLINED (only doctor/admin)', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'DECLINED', 'patient')).toThrow();
        });
        it('doctor cannot withdraw on the patient\'s behalf: PENDING -> CANCELLED_BY_PATIENT', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'CANCELLED_BY_PATIENT', 'doctor')).toThrow();
        });
        it('patient cannot mark their own appointment COMPLETED', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'COMPLETED', 'patient')).toThrow();
        });
        it('patient cannot mark NO_SHOW', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'NO_SHOW', 'patient')).toThrow();
        });
        it('only admin can force CANCELLED_BY_ADMIN — doctor cannot', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'CANCELLED_BY_ADMIN', 'doctor')).toThrow();
        });
        it('only admin can force CANCELLED_BY_ADMIN — patient cannot', () => {
            expect(() => assertValidAppointmentTransition('SCHEDULED', 'CANCELLED_BY_ADMIN', 'patient')).toThrow();
        });
    });

    describe('EXPIRED — reserved for the background job, no human actor', () => {
        it('is a legal shape-wise transition from PENDING', () => {
            expect(() => assertValidAppointmentTransitionShape('PENDING', 'EXPIRED')).not.toThrow();
        });
        it('cannot be triggered by any human actor via the actor-checked path — admin', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'EXPIRED', 'admin')).toThrow();
        });
        it('cannot be triggered by any human actor via the actor-checked path — doctor', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'EXPIRED', 'doctor')).toThrow();
        });
        it('cannot be triggered by any human actor via the actor-checked path — patient', () => {
            expect(() => assertValidAppointmentTransition('PENDING', 'EXPIRED', 'patient')).toThrow();
        });
    });

    describe('terminal states have no legal outgoing transition', () => {
        const terminal: AppointmentStatus[] = ['DECLINED', 'EXPIRED', 'COMPLETED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_DOCTOR', 'CANCELLED_BY_ADMIN', 'NO_SHOW'];
        it.each(terminal)('%s has an empty TRANSITIONS entry', (status) => {
            expect(TRANSITIONS[status]).toEqual([]);
        });
    });

    // Exhaustively verifies every (from, to) pair NOT explicitly listed as legal above
    // is rejected — catches a typo'd or missing TRANSITIONS entry that hand-picked
    // examples alone wouldn't surface.
    assertExhaustiveTransitionGraph(ALL_STATUSES, TRANSITIONS, assertValidAppointmentTransition, ['admin']);
});
