import { Clinic } from "@prisma/client";
import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";

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
}
