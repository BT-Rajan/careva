import { AppointmentValidation } from '../../app/modules/appointment/appointment.validation';
import { AuthValidation } from '../../app/modules/auth/auth.validation';

const validPayment = {
    paymentType: 'card',
    paymentMethod: 'visa',
};

const validPatientInfo = {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    phone: '555-0100',
    scheduleDate: '2026-09-01',
    scheduleTime: '10:00 am',
    doctorId: 'doctor-uuid',
};

describe('appointment.validation: CreateAppointmentValidation', () => {
    it('accepts a well-formed authenticated booking payload', () => {
        const result = AppointmentValidation.CreateAppointmentValidation.safeParse({
            body: { patientInfo: validPatientInfo, payment: validPayment },
        });
        expect(result.success).toBe(true);
    });

    it('rejects a payload missing doctorId — required on the authenticated path', () => {
        const { doctorId, ...withoutDoctorId } = validPatientInfo;
        const result = AppointmentValidation.CreateAppointmentValidation.safeParse({
            body: { patientInfo: withoutDoctorId, payment: validPayment },
        });
        expect(result.success).toBe(false);
    });

    it('rejects a payload with no payment block at all', () => {
        const result = AppointmentValidation.CreateAppointmentValidation.safeParse({
            body: { patientInfo: validPatientInfo },
        });
        expect(result.success).toBe(false);
    });

    it('rejects an invalid email', () => {
        const result = AppointmentValidation.CreateAppointmentValidation.safeParse({
            body: { patientInfo: { ...validPatientInfo, email: 'not-an-email' }, payment: validPayment },
        });
        expect(result.success).toBe(false);
    });

    it('rejects a missing scheduleDate', () => {
        const { scheduleDate, ...rest } = validPatientInfo;
        const result = AppointmentValidation.CreateAppointmentValidation.safeParse({
            body: { patientInfo: rest, payment: validPayment },
        });
        expect(result.success).toBe(false);
    });

    it('still accepts loosely-typed card fields — this layer does not validate card-number format (Pass 7 owns that)', () => {
        const result = AppointmentValidation.CreateAppointmentValidation.safeParse({
            body: {
                patientInfo: validPatientInfo,
                payment: { ...validPayment, cardNumber: 'not-a-real-card-number-format' },
            },
        });
        expect(result.success).toBe(true);
    });
});

describe('appointment.validation: CreateAppointmentByUnAuthenticateUserValidation', () => {
    it('accepts a guest booking payload with NO doctorId — optional on this path', () => {
        const { doctorId, ...withoutDoctorId } = validPatientInfo;
        const result = AppointmentValidation.CreateAppointmentByUnAuthenticateUserValidation.safeParse({
            body: { patientInfo: withoutDoctorId, payment: validPayment },
        });
        expect(result.success).toBe(true);
    });

    it('still requires the other core fields even for a guest', () => {
        const result = AppointmentValidation.CreateAppointmentByUnAuthenticateUserValidation.safeParse({
            body: { patientInfo: { doctorId: 'x' }, payment: validPayment },
        });
        expect(result.success).toBe(false);
    });
});

describe('appointment.validation: TrackAppointmentValidation', () => {
    it('accepts a non-empty tracking id', () => {
        expect(AppointmentValidation.TrackAppointmentValidation.safeParse({ body: { id: 'CV4F1A9B2C3D0E' } }).success).toBe(true);
    });
    it('rejects an empty tracking id', () => {
        expect(AppointmentValidation.TrackAppointmentValidation.safeParse({ body: { id: '' } }).success).toBe(false);
    });
});

describe('auth.validation', () => {
    it('LoginValidation accepts a valid email/password pair', () => {
        expect(AuthValidation.LoginValidation.safeParse({ body: { email: 'a@b.com', password: 'x' } }).success).toBe(true);
    });
    it('LoginValidation rejects an invalid email', () => {
        expect(AuthValidation.LoginValidation.safeParse({ body: { email: 'not-an-email', password: 'x' } }).success).toBe(false);
    });
    it('ChangePasswordValidation enforces the 8-character minimum on the new password', () => {
        expect(AuthValidation.ChangePasswordValidation.safeParse({ body: { currentPassword: 'old', newPassword: 'short' } }).success).toBe(false);
    });
    it('ChangePasswordValidation accepts a sufficiently long new password', () => {
        expect(AuthValidation.ChangePasswordValidation.safeParse({ body: { currentPassword: 'old', newPassword: 'longenough' } }).success).toBe(true);
    });
});
