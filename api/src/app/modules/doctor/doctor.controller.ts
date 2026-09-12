import { Request, Response } from "express";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { Doctor } from "@prisma/client";
import { DoctorService } from "./doctor.service";
import pick from "../../../shared/pick";
import { IDoctorFiltersData, IDoctorOptions } from "./doctor.interface";

const createDoctor = catchAsync(async (req: Request, res: Response) => {
    const result = await DoctorService.create(req.body);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Doctor Created !!',
        success: true,
        data: result
    })
})

const getAllDoctors = catchAsync(async (req: Request, res: Response) => {
    const filter = pick(req.query, IDoctorFiltersData);
    const options = pick(req.query, IDoctorOptions);
    const result = await DoctorService.getAllDoctors(filter, options);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Retrieve doctors !!',
        success: true,
        data: result,
    })
})

const getDoctor = catchAsync(async (req: Request, res: Response) => {
    const result = await DoctorService.getDoctor(req.params.id);
    sendResponse<Doctor>(res, {
        statusCode: 200,
        message: 'Successfully Get Doctor !!',
        success: true,
        data: result,
    })
})

const deleteDoctor = catchAsync(async (req: Request, res: Response) => {
    const result = await DoctorService.deleteDoctor(req.user, req.params.id);
    sendResponse<Doctor>(res, {
        statusCode: 200,
        message: 'Successfully Deleted Doctor !!',
        success: true,
        data: result,
    })
})

const updateDoctor = catchAsync(async (req: Request, res: Response) => {
    const result = await DoctorService.updateDoctor(req);
    sendResponse<Doctor>(res, {
        statusCode: 200,
        message: 'Successfully Updated Doctor !!',
        success: true,
        data: result,
    })
})

const getAllDoctorsForAdmin = catchAsync(async (req: Request, res: Response) => {
    const filter = pick(req.query, IDoctorFiltersData);
    const options = pick(req.query, IDoctorOptions);
    // Pass 28 — Multi-Tenant Clinics (query scoping). THIS is the actual leak fix: this
    // used to call the service with no clinic context at all, so any authenticated
    // admin saw every clinic's doctors. clinicId comes from the admin's own verified
    // token (req.user, set by the auth middleware from the JWT) — never from
    // req.query, which the client fully controls and could set to anything.
    // super_admin gets undefined here on purpose: the one role allowed to see across
    // every clinic. Every other role reaching this line is 'admin' (enforced by the
    // route's auth(AuthUser.ADMIN) — see doctor.route.ts), which always has a
    // clinicId on its token per Pass 27/28's Auth model.
    const clinicId = req.user?.role === 'super_admin' ? undefined : req.user?.clinicId;
    const result = await DoctorService.getAllDoctorsForAdmin(filter, options, clinicId);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Retrieve doctors !!',
        success: true,
        data: result,
    })
})

const updateApprovalStatus = catchAsync(async (req: Request, res: Response) => {
    const { status, reason } = req.body;
    // Pass 28 — Multi-Tenant Clinics (query scoping). Approval status now lives on
    // DoctorClinic (per clinic affiliation), so the request must say WHICH affiliation
    // is changing. For an 'admin' actor, that's always their own clinic — taken from
    // their token, never from the request body, so an admin can't target a doctor's
    // affiliation at a clinic that isn't theirs. 'doctor' (self-service, e.g.
    // deactivating themselves at one clinic while staying active at another) and
    // 'super_admin' (no clinic on their token) both must specify clinicId explicitly.
    const clinicId = req.user?.role === 'admin' ? req.user?.clinicId : req.body.clinicId;
    const result = await DoctorService.updateApprovalStatus(req.user, req.params.id, clinicId, status, reason);
    sendResponse<Doctor>(res, {
        statusCode: 200,
        message: 'Successfully Updated Doctor Approval Status !!',
        success: true,
        data: result,
    })
})

export const DoctorController = {
    createDoctor,
    updateDoctor,
    updateApprovalStatus,
    deleteDoctor,
    getAllDoctors,
    getAllDoctorsForAdmin,
    getDoctor
}