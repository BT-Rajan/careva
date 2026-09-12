import { Request, Response } from "express";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { PatientService } from "./patient.service";
import { Patient } from "@prisma/client";

const createPatient = catchAsync(async (req: Request, res: Response) => {
    await PatientService.createPatient(req.body);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Patient Created !!',
        success: true
    })
})

const getAllPatients = catchAsync(async (req: Request, res: Response) => {
    // Pass 28 — Multi-Tenant Clinics (query scoping). Same fix pattern used everywhere
    // else in this pass: clinicId comes from the admin's own verified token, never
    // from the client. undefined only for super_admin.
    const clinicId = req.user?.role === 'super_admin' ? undefined : (req.user as any)?.clinicId;
    const result = await PatientService.getAllPatients(clinicId);
    sendResponse<Patient[]>(res, {
        statusCode: 200,
        message: 'Successfully Get Patients !!',
        success: true,
        data: result,
    })
})

const getPatient = catchAsync(async (req: Request, res: Response) => {
    const result = await PatientService.getPatient(req.user, req.params.id);
    sendResponse<Patient>(res, {
        statusCode: 200,
        message: 'Successfully Get Patient !!',
        success: true,
        data: result,
    })
})

const deletePatient = catchAsync(async (req: Request, res: Response) => {
    const result = await PatientService.deletePatient(req.user, req.params.id);
    sendResponse<Patient>(res, {
        statusCode: 200,
        message: 'Successfully Deleted Patient !!',
        success: true,
        data: result,
    })
})

const reactivatePatient = catchAsync(async (req: Request, res: Response) => {
    const result = await PatientService.reactivatePatient(req.user, req.params.id);
    sendResponse<Patient>(res, {
        statusCode: 200,
        message: 'Successfully Reactivated Patient !!',
        success: true,
        data: result,
    })
})

const updatePatient = catchAsync(async (req: Request, res: Response) => {
    const result = await PatientService.updatePatient(req);
    sendResponse<Patient>(res, {
        statusCode: 200,
        message: 'Successfully Updated Patient !!',
        success: true,
        data: result
    })
})

const deleteMyAccount = catchAsync(async (req: Request, res: Response) => {
    const result = await PatientService.deleteMyAccount(req.user, req.body?.password);
    sendResponse(res, {
        statusCode: 200,
        message: result.message,
        success: true,
    })
})

export const PatientController = {
    createPatient,
    updatePatient,
    getPatient,
    getAllPatients,
    deletePatient,
    reactivatePatient,
    deleteMyAccount,
}