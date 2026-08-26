/**
 * Pass 17 — API Contract. `disease` is the only clinical-content field the schema
 * itself requires (everything else on Prescription is nullable) — matching that here
 * rather than inventing a stricter contract than the data model has. `medicine` items
 * are all-optional strings for the same reason (see the Medicine model).
 */
import { z } from 'zod';

const medicineItem = z.object({
    medicine: z.string().optional(),
    dosage: z.string().optional(),
    frequency: z.string().optional(),
    duration: z.string().optional(),
});

const CreatePrescriptionValidation = z.object({
    body: z.object({
        appointmentId: z.string().min(1, 'appointmentId is required'),
        disease: z.string().trim().min(1, 'disease is required'),
        daignosis: z.string().optional(),
        test: z.string().optional(),
        instruction: z.string().optional(),
        followUpdate: z.string().optional(),
        patientType: z.string().optional(),
        medicine: z.array(medicineItem).optional(),
    }).passthrough(),
});

export const PrescriptionValidation = {
    CreatePrescriptionValidation,
};
