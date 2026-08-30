import { DoctorApprovalStatus } from '@prisma/client';
import { TRANSITIONS, assertValidDoctorApprovalTransition, getProfileCompleteness } from '../../app/modules/doctor/doctor-lifecycle';
import { assertExhaustiveTransitionGraph } from './stateMachineTestHelpers';

const ALL_STATUSES: DoctorApprovalStatus[] = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUSPENDED', 'DEACTIVATED'];

describe('doctor-lifecycle: assertValidDoctorApprovalTransition', () => {
    describe('legal transitions succeed for their documented actors', () => {
        it('admin can approve PENDING_APPROVAL -> APPROVED', () => {
            expect(() => assertValidDoctorApprovalTransition('PENDING_APPROVAL', 'APPROVED', 'admin')).not.toThrow();
        });
        it('admin can reject PENDING_APPROVAL -> REJECTED', () => {
            expect(() => assertValidDoctorApprovalTransition('PENDING_APPROVAL', 'REJECTED', 'admin')).not.toThrow();
        });
        it('admin can re-open REJECTED -> PENDING_APPROVAL', () => {
            expect(() => assertValidDoctorApprovalTransition('REJECTED', 'PENDING_APPROVAL', 'admin')).not.toThrow();
        });
        it('admin can suspend APPROVED -> SUSPENDED', () => {
            expect(() => assertValidDoctorApprovalTransition('APPROVED', 'SUSPENDED', 'admin')).not.toThrow();
        });
        it('admin can lift a suspension SUSPENDED -> APPROVED', () => {
            expect(() => assertValidDoctorApprovalTransition('SUSPENDED', 'APPROVED', 'admin')).not.toThrow();
        });
        it('doctor can deactivate their own account APPROVED -> DEACTIVATED', () => {
            expect(() => assertValidDoctorApprovalTransition('APPROVED', 'DEACTIVATED', 'doctor')).not.toThrow();
        });
        it('admin can also deactivate a doctor APPROVED -> DEACTIVATED', () => {
            expect(() => assertValidDoctorApprovalTransition('APPROVED', 'DEACTIVATED', 'admin')).not.toThrow();
        });
        it('doctor can reactivate their own account DEACTIVATED -> APPROVED', () => {
            expect(() => assertValidDoctorApprovalTransition('DEACTIVATED', 'APPROVED', 'doctor')).not.toThrow();
        });
    });

    describe('actor restrictions on otherwise-legal edges', () => {
        it('doctor cannot approve their own pending application', () => {
            expect(() => assertValidDoctorApprovalTransition('PENDING_APPROVAL', 'APPROVED', 'doctor')).toThrow();
        });
        it('doctor cannot reject an application (only admin reviews)', () => {
            expect(() => assertValidDoctorApprovalTransition('PENDING_APPROVAL', 'REJECTED', 'doctor')).toThrow();
        });
        it('doctor cannot lift their own suspension — only admin', () => {
            expect(() => assertValidDoctorApprovalTransition('SUSPENDED', 'APPROVED', 'doctor')).toThrow();
        });
        it('doctor cannot re-open their own rejected application', () => {
            expect(() => assertValidDoctorApprovalTransition('REJECTED', 'PENDING_APPROVAL', 'doctor')).toThrow();
        });
    });

    describe('terminal-shaped states still constrained correctly', () => {
        it('SUSPENDED can only go back to APPROVED, nothing else', () => {
            expect(TRANSITIONS.SUSPENDED).toEqual(['APPROVED']);
        });
        it('REJECTED can only go back to PENDING_APPROVAL, nothing else', () => {
            expect(TRANSITIONS.REJECTED).toEqual(['PENDING_APPROVAL']);
        });
    });

    assertExhaustiveTransitionGraph(ALL_STATUSES, TRANSITIONS, assertValidDoctorApprovalTransition, ['admin']);
});

describe('doctor-lifecycle: getProfileCompleteness', () => {
    it('reports complete when every required field is present', () => {
        const result = getProfileCompleteness({
            phone: '555-0100',
            specialization: 'Cardiology',
            designation: 'Senior Consultant',
            clinicName: 'Careva Heart Clinic',
            biography: 'A'.repeat(30),
            price: 100,
        });
        expect(result.complete).toBe(true);
        expect(result.missing).toEqual([]);
    });

    it('reports every missing field by name, not just that something is missing', () => {
        const result = getProfileCompleteness({});
        expect(result.complete).toBe(false);
        expect(result.missing).toEqual(expect.arrayContaining([
            'Phone number', 'Specialization', 'Designation', 'Clinic name or address',
            'Biography (at least 30 characters)', 'Consultation fee',
        ]));
    });

    it('accepts either clinicName OR clinicAddress, not both required', () => {
        const result = getProfileCompleteness({
            phone: '1', specialization: 'x', designation: 'y',
            clinicAddress: '123 Main St', biography: 'B'.repeat(30), price: 1,
        });
        expect(result.missing).not.toContain('Clinic name or address');
    });

    it('enforces the 30-character biography minimum — 29 characters is not enough', () => {
        const result = getProfileCompleteness({
            phone: '1', specialization: 'x', designation: 'y', clinicName: 'z',
            biography: 'A'.repeat(29), price: 1,
        });
        expect(result.missing).toContain('Biography (at least 30 characters)');
    });

    it('treats a whitespace-only biography as missing, not merely short', () => {
        const result = getProfileCompleteness({
            phone: '1', specialization: 'x', designation: 'y', clinicName: 'z',
            biography: '   ', price: 1,
        });
        expect(result.missing).toContain('Biography (at least 30 characters)');
    });

    it('accepts price of 0 as present (a real, deliberate fee, not "unset")', () => {
        const result = getProfileCompleteness({
            phone: '1', specialization: 'x', designation: 'y', clinicName: 'z',
            biography: 'A'.repeat(30), price: 0,
        });
        expect(result.missing).not.toContain('Consultation fee');
    });
});
