/**
 * Pass 17 — API Contract.
 *
 * Booking is this app's highest-traffic write path and the one most exposed to
 * malformed/adversarial input (guest booking in particular needs no auth at all — see
 * Pass 15). Before this pass, `createAppointment`/`createAppointmentByUnAuthenticateUser`
 * were typed `payload: any` and validated nothing about request shape before touching
 * the database — a missing `scheduleDate`, a `doctorId` that isn't a string, or a
 * `payment` block missing entirely would either 500 from a downstream Prisma/type error
 * or silently misbehave, rather than a clean 400 telling the client what's wrong.
 *
 * Deliberately loose on payment card fields (cardNumber/cvv/etc. stay untyped-ish
 * optional strings) — validating card-number format here would just be re-implementing
 * what an actual payment provider integration validates, and Pass 7 already covers the
 * transaction/charge logic; this schema's job is "is the request well-formed enough to
 * process," not full business-rule enforcement (approval status, slot availability,
 * etc. — all already correctly enforced in appointment.service.ts, not duplicated here).
 */
import { z } from 'zod';

// Adversarial stress-test finding (post Pass 26): `phone` previously only checked
// non-empty — any string of any shape was accepted on this app's highest-traffic write
// path. Kuwait numbers are 8 digits, optionally prefixed with `+965`/`965`, and start
// with 2 (landline), or 5/6/9 (mobile) — this validates that shape after stripping
// spaces/dashes, so "+965 5555 5555", "965-5555-5555", and "55555555" all pass, but
// garbage input that would otherwise silently break appointment-confirmation contact
// (this app's only reminder channel today — see the top-10 review) does not.
const KUWAIT_PHONE_REGEX = /^(?:\+?965)?[2569]\d{7}$/;

const patientInfoCore = {
    firstName: z.string().trim().min(1, 'First name is required'),
    lastName: z.string().trim().min(1, 'Last name is required'),
    email: z.string().trim().email('A valid email is required'),
    phone: z.string().trim().min(1, 'Phone is required').refine(
        (val) => KUWAIT_PHONE_REGEX.test(val.replace(/[\s-]/g, '')),
        { message: 'Enter a valid Kuwait phone number, e.g. +965 5555 5555' }
    ),
    scheduleDate: z.string().trim().min(1, 'Schedule date is required'),
    scheduleTime: z.string().trim().min(1, 'Schedule time is required'),
    patientId: z.string().optional(),
    reasonForVisit: z.string().optional(),
    description: z.string().optional(),
    address: z.string().optional(),
};

const paymentCore = z.object({
    paymentType: z.string().trim().min(1, 'Payment type is required'),
    paymentMethod: z.string().trim().min(1, 'Payment method is required'),
    cardNumber: z.string().optional(),
    cardExpiredYear: z.string().optional(),
    cvv: z.string().optional(),
    expiredMonth: z.string().optional(),
    nameOnCard: z.string().optional(),
});

// doctorId required — the authenticated create path 404s if it's missing/invalid
// anyway (appointment.service.ts looks it up unconditionally), so requiring it here
// just moves that failure from a service-layer NOT_FOUND to a cleaner 400.
const CreateAppointmentValidation = z.object({
    body: z.object({
        patientInfo: z.object({
            ...patientInfoCore,
            doctorId: z.string().min(1, 'Doctor is required'),
        }),
        payment: paymentCore,
    }),
});

// doctorId optional here — createAppointmentByUnAuthenticateUser falls back to
// config.defaultAdminDoctor when it's absent; that's an intentional product behavior
// for the guest path, not something this schema should block.
const CreateAppointmentByUnAuthenticateUserValidation = z.object({
    body: z.object({
        patientInfo: z.object({
            ...patientInfoCore,
            doctorId: z.string().optional(),
        }),
        payment: paymentCore,
    }),
});

const TrackAppointmentValidation = z.object({
    body: z.object({
        id: z.string().trim().min(1, 'Tracking ID is required'),
    }),
});

export const AppointmentValidation = {
    CreateAppointmentValidation,
    CreateAppointmentByUnAuthenticateUserValidation,
    TrackAppointmentValidation,
};
