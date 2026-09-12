import { Clinic } from "@prisma/client";
import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import { encryptCredential } from "../../../helpers/credentialCrypto";

/**
 * Pass 30 — Multi-Tenant Clinics (frontend wiring), gap found while starting this pass.
 *
 * Passes 27-29 built the entire Clinic data model (schema, DoctorClinic affiliation,
 * clinicId scoping across every module) but never built an actual API for the Clinic
 * model itself — there was no way for the frontend to even list clinics for a signup
 * picker or a booking page. This is that minimal API: public read-only endpoints
 * (list + lookup by slug) needed to make every clinicId-required frontend form
 * (signup, booking, blog creation) actually functional. Clinic creation/editing
 * (the self-serve "create your clinic" signup flow) is still Pass 32's job — this
 * pass only makes EXISTING clinics (so far just the "Legacy Clinic" from Pass 27's
 * migration) visible and selectable.
 */

// Deliberately narrow — never exposes gmailAppPassEnc/imageApiSecretEnc/etc. Public
// callers (a signup form, a booking page) need only enough to let someone pick a
// clinic, never its integration credentials.
const PUBLIC_CLINIC_SELECT = {
    id: true,
    name: true,
    slug: true,
    status: true,
} as const;

const getAllClinics = async (): Promise<Partial<Clinic>[]> => {
    return prisma.clinic.findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        select: PUBLIC_CLINIC_SELECT,
        orderBy: { name: 'asc' },
    });
}

const getClinicBySlug = async (slug: string): Promise<Partial<Clinic>> => {
    const clinic = await prisma.clinic.findFirst({
        where: { slug, status: 'ACTIVE', deletedAt: null },
        select: PUBLIC_CLINIC_SELECT,
    });
    if (!clinic) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Clinic is not found !!');
    }
    return clinic;
}

export const ClinicService = {
    getAllClinics,
    getClinicBySlug,
    updateEmailSettings,
}

/**
 * Pass 31 — Multi-Tenant Clinics (per-clinic email). The write side of the credential
 * columns Pass 27 added and this pass's Transporter changes started reading — nothing
 * could actually SET a clinic's own Gmail credentials before this. Admin-only, and
 * strictly scoped to the caller's own clinic (super_admin can act on any clinic by
 * passing its id).
 *
 * Takes the plaintext app password over the wire (same trust model as any credential
 * submission form — this endpoint must be served over HTTPS in production, same as
 * login) and encrypts it before it ever touches the database; the plaintext is never
 * persisted or logged.
 */
async function updateEmailSettings(reqUser: any, clinicId: string, gmailAppEmail: string, gmailAppPassword: string): Promise<Partial<Clinic>> {
    const isSuperAdmin = reqUser?.role === 'super_admin';
    if (reqUser?.role !== 'admin' && !isSuperAdmin) {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only a clinic admin can update email settings !!');
    }
    if (!isSuperAdmin && reqUser?.clinicId !== clinicId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update another clinic\'s settings !!');
    }
    if (!gmailAppEmail || !gmailAppPassword) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'gmailAppEmail and gmailAppPassword are required !!');
    }
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    if (!clinic) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Clinic is not found !!');
    }
    const updated = await prisma.clinic.update({
        where: { id: clinicId },
        data: {
            gmailAppEmail,
            gmailAppPassEnc: encryptCredential(gmailAppPassword),
        },
        select: { id: true, name: true, slug: true, gmailAppEmail: true }, // never select gmailAppPassEnc back out
    });
    return updated;
}
