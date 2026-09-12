/**
 * Pass 17 — API Contract. Same reasoning as doctor.validation.ts's CreateDoctorValidation
 * — only the account-creation core is required, matching what the Patient model itself
 * requires; every other field (address, dateOfBirth, bloodGroup, etc.) stays optional.
 *
 * Pass 28 — Multi-Tenant Clinics (query scoping). clinicId is required — Patient.clinicId
 * is a required column since Pass 27 (a patient belongs to exactly one clinic), so
 * signup must say which one. The individual clinic/doctor page a patient signs up
 * through is expected to carry this.
 */
import { z } from 'zod';

const CreatePatientValidation = z.object({
    body: z.object({
        firstName: z.string().trim().min(1, 'First name is required'),
        lastName: z.string().trim().min(1, 'Last name is required'),
        email: z.string().trim().email('A valid email is required'),
        password: z.string().min(8, 'Password must be at least 8 characters'),
        clinicId: z.string().trim().min(1, 'clinicId is required'),
    }).passthrough(),
});

// Pass 24 — Data Privacy & Retention.
const DeleteMyAccountValidation = z.object({
    body: z.object({
        password: z.string().min(1, 'Your current password is required to delete your account.'),
    }),
});

export const PatientValidation = {
    CreatePatientValidation,
    DeleteMyAccountValidation,
};
