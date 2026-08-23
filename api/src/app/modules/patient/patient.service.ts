import { Patient, UserRole } from "@prisma/client";
import prisma from "../../../shared/prisma";
import { create } from "./patientService";
import { IUpload } from "../../../interfaces/file";
import { Request } from "express";
import { CloudinaryHelper } from "../../../helpers/uploadHelper";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";

const createPatient = async (payload: any): Promise<any> => {
    const result = await create(payload)
    return result;
}

// Pass 12 — Patient Data & Medical Records: soft-delete wiring. Pass 2 added
// `Patient.deletedAt` as scaffolding and explicitly deferred wiring it to this pass — a
// soft-deleted patient is now hidden from every listing/lookup by default.
const getAllPatients = async (): Promise<Patient[] | null> => {
    const result = await prisma.patient.findMany({
        where: { deletedAt: null }
    });
    return result;
}

const getPatient = async (reqUser: any, id: string): Promise<Patient | null> => {
    // Pass 4: previously no ownership check at all — any caller could fetch any
    // patient's full profile by id.
    const isAdmin = reqUser?.role === 'admin';
    if (!isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to view this patient !!");
    }
    const result = await prisma.patient.findFirst({
        where: {
            id: id,
            deletedAt: null
        }
    });
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
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can reactivate a patient account !!');
    }
    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient is not found !!');
    }
    if (!patient.deletedAt) {
        throw new ApiError(httpStatus.CONFLICT, 'This patient account is not deactivated !!');
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

// Pass 4: fields no caller may set through this endpoint via mass-assignment.
const PATIENT_PROTECTED_FIELDS = ['id', 'email', 'createdAt', 'updatedAt', 'deletedAt'];

// : Promise<Patient>
const updatePatient = async (req: Request): Promise<Patient | null> => {
    const file = req.file as IUpload;
    const id = req.params.id as string;
    const user = JSON.parse(req.body.data)
    const reqUser: any = req.user;
    const isAdmin = reqUser?.role === 'admin';

    // Pass 4: previously any authenticated patient could update ANY OTHER patient's
    // profile by supplying a different id — no ownership check at all.
    if (!isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to update this patient !!");
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
    reactivatePatient
}