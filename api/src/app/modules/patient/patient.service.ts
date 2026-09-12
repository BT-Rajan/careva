import { Patient, UserRole } from "@prisma/client";
import prisma from "../../../shared/prisma";
import { create } from "./patientService";
import { IUpload } from "../../../interfaces/file";
import { Request } from "express";
import { CloudinaryHelper } from "../../../helpers/uploadHelper";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import bcrypt from "bcrypt";

const createPatient = async (payload: any): Promise<any> => {
    const result = await create(payload)
    return result;
}

// Pass 12 — Patient Data & Medical Records: soft-delete wiring. Pass 2 added
// `Patient.deletedAt` as scaffolding and explicitly deferred wiring it to this pass — a
// soft-deleted patient is now hidden from every listing/lookup by default.
//
// Pass 28 — Multi-Tenant Clinics (query scoping). This was completely unscoped — any
// admin, from any clinic, could list every patient on the entire platform. Same fix
// pattern as doctor.service.ts's getAllDoctors and appointment.service.ts's
// getAllAppointments: clinicId comes from the caller (the admin's own token), undefined
// only for super_admin.
const getAllPatients = async (clinicId?: string): Promise<Patient[] | null> => {
    const result = await prisma.patient.findMany({
        where: { deletedAt: null, ...(clinicId ? { clinicId } : {}) }
    });
    return result;
}

const getPatient = async (reqUser: any, id: string): Promise<Patient | null> => {
    const result = await prisma.patient.findFirst({
        where: {
            id: id,
            deletedAt: null
        }
    });
    // Pass 4: previously no ownership check at all — any caller could fetch any
    // patient's full profile by id.
    // Pass 28 — Multi-Tenant Clinics (query scoping). An 'admin' may only view a
    // patient belonging to their own clinic — checked against the actual record (not
    // just role) so a missing patient and a cross-clinic patient both fail the same way.
    const isSuperAdmin = reqUser?.role === 'super_admin';
    const isAdmin = reqUser?.role === 'admin' && result?.clinicId === reqUser?.clinicId;
    if (!isSuperAdmin && !isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to view this patient !!");
    }
    return result;
}

// Pass 12 BUG FIX / deliberate behavior change: previously hard-deleted the Patient row
// and its Auth row together — permanently destroying medical-adjacent data (appointment
// history, prescriptions, reviews all reference this patient) with no way to recover it,
// exactly the hazard Pass 2's onDelete: Restrict/SetNull choices were designed to guard
// against at the DB layer, undermined by deleting the row outright. Now soft-deletes:
// sets `deletedAt`, leaves the row (and everything that references it) intact, and drops
// the Auth row so the account can no longer log in. Admin-only (unchanged from Pass 4);
// a patient-initiated "delete my own account" flow is Pass 24's job (Data Privacy &
// Retention), which owns the consent/confirmation UX this deserves.
const deletePatient = async (reqUser: any, id: string): Promise<any> => {
    const patient = await prisma.patient.findFirst({ where: { id, deletedAt: null } });
    if (!patient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient is not found !!');
    }
    // Pass 28 — Multi-Tenant Clinics (query scoping). An 'admin' may only deactivate a
    // patient at their own clinic — super_admin is unrestricted. This route is
    // admin-only (see patient.route.ts), so there's no separate self/owner path here.
    const isSuperAdmin = reqUser?.role === 'super_admin';
    const isAdmin = reqUser?.role === 'admin' && patient.clinicId === reqUser?.clinicId;
    if (!isSuperAdmin && !isAdmin) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to deactivate this patient !!');
    }
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.patient.update({
            where: { id },
            data: { deletedAt: new Date() }
        });
        await tx.auth.deleteMany({
            where: { email: patient.email }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'patient.deactivated',
                entityType: 'Patient',
                entityId: id,
                metadata: {},
            }
        });
        return updated;
    });
    return result;
}

// Pass 12: companion to the soft-delete above — an admin can reverse a deactivation.
// Does NOT restore the Auth row (the patient would need to register again with the same
// email, which Auth.email's uniqueness already permits once the old row's Auth is gone) —
// full account restoration including credentials is a bigger decision left undecided
// here rather than guessed at.
const reactivatePatient = async (reqUser: any, id: string): Promise<Patient> => {
    const isSuperAdmin = reqUser?.role === 'super_admin';
    if (reqUser?.role !== 'admin' && !isSuperAdmin) {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can reactivate a patient account !!');
    }
    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient is not found !!');
    }
    // Pass 28 — Multi-Tenant Clinics (query scoping). Same pattern as deletePatient —
    // an 'admin' may only reactivate a patient at their own clinic.
    if (!isSuperAdmin && patient.clinicId !== reqUser?.clinicId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can reactivate a patient account !!');
    }
    if (!patient.deletedAt) {
        throw new ApiError(httpStatus.CONFLICT, 'This patient account is not deactivated !!');
    }
    // Pass 24: a self-deleted (PII-scrubbed) account has nothing left to restore — its
    // name/email/contact fields are anonymized placeholders, not the patient's real
    // data. "Reactivating" it would just make a row full of placeholder data visible
    // again, which isn't a real undo and would be actively misleading to whoever
    // reactivated it expecting the original account back.
    if (patient.piiScrubbed) {
        throw new ApiError(httpStatus.CONFLICT, 'This account was deleted by the patient and its data was anonymized — it cannot be restored. The patient would need to register a new account.');
    }
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.patient.update({
            where: { id },
            data: { deletedAt: null }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'patient.reactivated',
                entityType: 'Patient',
                entityId: id,
                metadata: {},
            }
        });
        return updated;
    });
    return result;
}

// Pass 24 — Data Privacy & Retention. The patient-initiated counterpart to
// deletePatient above — Pass 12 deliberately left this admin-only, flagging a real
// self-service "delete my account" flow (with proper consent/confirmation UX) as this
// pass's job.
//
// Genuinely anonymizes PII rather than only soft-deleting (the admin path's
// `deletedAt`-only approach is designed to be reversible and leaves every field
// intact — appropriate for an admin deactivation, not for a patient's own
// right-to-erasure request). The row itself is kept, not hard-deleted: appointments,
// prescriptions, invoices, and reviews all reference this patient by id, and those are
// records this app's own earlier passes established must be retained (Prescription
// and Invoice are explicitly "never hard-deleted, medical/legal records" — Pass 13/14).
// Anonymizing the Patient row instead of deleting it preserves that legally-required
// history while removing the actual personal information from it — the standard
// resolution to "right to erasure" vs. "must retain financial/medical records."
//
// Requires the account's own current password as re-confirmation before a destructive,
// irreversible action — standard security UX, and cheap protection against e.g. an
// unattended logged-in session being used to delete the account without the owner's
// knowledge.
const deleteMyAccount = async (reqUser: any, password: string): Promise<{ message: string }> => {
    if (reqUser?.role !== 'patient') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only a patient can delete their own account this way !!');
    }
    if (!password) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Your current password is required to delete your account.');
    }
    const patient = await prisma.patient.findFirst({ where: { id: reqUser.userId, deletedAt: null } });
    if (!patient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient account is not found !!');
    }
    const authRecord = await prisma.auth.findUnique({ where: { email: patient.email } });
    if (!authRecord) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Account credentials are not found !!');
    }
    const isPasswordMatched = await bcrypt.compare(password, authRecord.password);
    if (!isPasswordMatched) {
        throw new ApiError(httpStatus.FORBIDDEN, 'Incorrect password.');
    }

    await prisma.$transaction(async (tx) => {
        await tx.patient.update({
            where: { id: patient.id },
            data: {
                firstName: 'Deleted',
                lastName: 'Patient',
                // Unique placeholder, not a fixed string — Patient.email is @unique,
                // and a fixed placeholder would collide the second time anyone ever
                // deletes their account.
                email: `deleted-${patient.id}@deleted.careva.local`,
                mobile: null,
                address: null,
                city: null,
                state: null,
                zipCode: null,
                country: null,
                dateOfBirth: null,
                bloodGroup: null,
                gender: null,
                img: null,
                deletedAt: new Date(),
                piiScrubbed: true,
            }
        });
        await tx.auth.deleteMany({ where: { email: patient.email } });
        await tx.auditLog.create({
            data: {
                actorId: patient.id,
                actorRole: 'patient',
                action: 'patient.self_deleted',
                entityType: 'Patient',
                entityId: patient.id,
                metadata: {},
            }
        });
    });

    return { message: 'Your account has been deleted and your personal data has been removed.' };
}

// Pass 4: fields no caller may set through this endpoint via mass-assignment.
// Pass 28: clinicId added — reassigning a patient to a different clinic should never
// be a side effect of an ordinary profile edit.
const PATIENT_PROTECTED_FIELDS = ['id', 'email', 'createdAt', 'updatedAt', 'deletedAt', 'clinicId'];

// : Promise<Patient>
const updatePatient = async (req: Request): Promise<Patient | null> => {
    const file = req.file as IUpload;
    const id = req.params.id as string;
    const user = JSON.parse(req.body.data)
    const reqUser: any = req.user;
    const isSuperAdmin = reqUser?.role === 'super_admin';
    const isAdmin = reqUser?.role === 'admin';

    // Pass 4: previously any authenticated patient could update ANY OTHER patient's
    // profile by supplying a different id — no ownership check at all.
    if (!isSuperAdmin && !isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to update this patient !!");
    }
    // Pass 28 — Multi-Tenant Clinics (query scoping). An 'admin' may only edit a
    // patient belonging to their own clinic — same leak shape as every other
    // admin-facing endpoint fixed in this pass.
    if (isAdmin) {
        const target = await prisma.patient.findUnique({ where: { id } });
        if (!target || target.clinicId !== reqUser.clinicId) {
            throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to update this patient !!");
        }
    }
    for (const field of PATIENT_PROTECTED_FIELDS) {
        delete user[field];
    }
    if (file) {
        const uploadImage = await CloudinaryHelper.uploadFile(file);
        if (uploadImage) {
            user.img = uploadImage.secure_url
        } else {
            throw new ApiError(httpStatus.EXPECTATION_FAILED, 'Failed to updateImage !!')
        }
    }
    const result = await prisma.patient.update({
        where: { id },
        data: user
    })
    return result;
}

export const PatientService = {
    createPatient,
    updatePatient,
    getPatient,
    getAllPatients,
    deletePatient,
    reactivatePatient,
    deleteMyAccount,
}