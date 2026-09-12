import nodemailer from 'nodemailer';
import config from '../config';
import { decryptCredential } from './credentialCrypto';

// Pass 31 — Multi-Tenant Clinics (per-clinic email). Kept as the fallback default —
// used for any clinic that hasn't configured its own Gmail credentials yet (every
// clinic today, until Pass 32's clinic-settings UI exists), and for any notification
// with no clinic context at all (clinicId null — see notification.service.ts).
export const Transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: config.gmail_app_Email,
        pass: config.emailPass
    }
});

// A transporter per distinct Gmail account is cheap to hold onto (nodemailer pools
// connections internally) and avoids re-creating one on every single email send for
// clinics that send frequently.
const clinicTransporterCache = new Map<string, nodemailer.Transporter>();

/**
 * Pass 31 — Multi-Tenant Clinics (per-clinic email). Returns a transporter using the
 * clinic's own Gmail credentials if it has them configured, falling back to the
 * platform-wide default Transporter above otherwise. This is the actual "per-client
 * Gmail" mechanism the person asked for back when this whole multi-tenant conversion
 * started — Clinic.gmailAppEmail/gmailAppPassEnc have existed as schema columns since
 * Pass 27 but nothing read them until now.
 */
export const getTransporterForClinic = (clinic?: { gmailAppEmail: string | null; gmailAppPassEnc: string | null } | null): nodemailer.Transporter => {
    if (!clinic?.gmailAppEmail || !clinic?.gmailAppPassEnc) {
        return Transporter;
    }
    const cached = clinicTransporterCache.get(clinic.gmailAppEmail);
    if (cached) {
        return cached;
    }
    let plainPass: string;
    try {
        plainPass = decryptCredential(clinic.gmailAppPassEnc);
    } catch (err) {
        // Fail safe, not silent: a clinic with a corrupted/undecryptable credential
        // still gets its email sent, just from the platform default account, rather
        // than the whole send failing outright over a credentials problem the
        // recipient has no way to know about or fix.
        console.error(`Failed to decrypt Gmail credential for clinic email ${clinic.gmailAppEmail}, falling back to default sender:`, err);
        return Transporter;
    }
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: clinic.gmailAppEmail,
            pass: plainPass,
        }
    });
    clinicTransporterCache.set(clinic.gmailAppEmail, transporter);
    return transporter;
}

