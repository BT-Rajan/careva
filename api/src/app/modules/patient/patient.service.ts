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

const getAllPatients = async (): Promise<Patient[] | null> => {
    const result = await prisma.patient.findMany();
    return result;
}

const getPatient = async (reqUser: any, id: string): Promise<Patient | null> => {
    // Pass 4: previously no ownership check at all — any caller could fetch any
    // patient's full profile by id.
    const isAdmin = reqUser?.role === 'admin';
    if (!isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to view this patient !!");
    }
    const result = await prisma.patient.findUnique({
        where: {
            id: id
        }
    });
    return result;
}

const deletePatient = async (id: string): Promise<any> => {
    const result = await prisma.$transaction(async (tx) => {
        const patient = await tx.patient.delete({
            where: {
                id: id
            }
        });
        await tx.auth.delete({
            where: {
                email: patient.email
            }
        })
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
    deletePatient
}