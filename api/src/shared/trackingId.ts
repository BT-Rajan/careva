/**
 * Pass 15 — Tracking & Public Access.
 *
 * Previously (appointment.service.ts, both createAppointment and
 * createAppointmentByUnAuthenticateUser) trackingId was built as:
 *   first 3 letters of the patient's name + year + month + day-of-year + a small
 *   sequential counter derived from the previous row.
 *
 * The app's own public tracking page (TrackAppointment.jsx) tells patients "Only
 * someone with your tracking ID can load this summary" — i.e. trackingId IS the
 * credential for a public, unauthenticated lookup that returns real PII/PHI (patient
 * name, address, email, reason for visit — see appointment.service.ts's
 * getAppointmentByTrackingId). A name-prefix + date + 3-digit-counter format is exactly
 * the opposite of unguessable: a first name is not a secret, the date is often knowable
 * or narrow to search, and the counter is a 3-digit space — trivially enumerable per
 * clinic-day. This generator replaces it with a real random token, closing that gap at
 * the source rather than only at the display layer.
 *
 * Kept short enough to type/copy (the product's own UX — TrackAppointment.jsx's search
 * box — expects a pasted code, not a 256-bit blob): 12 hex characters from 6 random
 * bytes is 2^48 possibilities, several orders of magnitude past anything enumerable,
 * while still being a plain alphanumeric string. A short brand prefix keeps it visually
 * recognizable as a Careva reference number rather than a raw hex string.
 */
import crypto from 'crypto';

export const generateTrackingId = (): string => {
    return `CV${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
};
