import { Request, Response } from "express";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { ClinicService } from "./clinic.service";

const getAllClinics = catchAsync(async (req: Request, res: Response) => {
    const result = await ClinicService.getAllClinics();
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Retrieve Clinics !!',
        success: true,
        data: result,
    })
})

const getClinicBySlug = catchAsync(async (req: Request, res: Response) => {
    const result = await ClinicService.getClinicBySlug(req.params.slug);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Retrieve Clinic !!',
        success: true,
        data: result,
    })
})

const updateEmailSettings = catchAsync(async (req: Request, res: Response) => {
    const { gmailAppEmail, gmailAppPassword } = req.body;
    const result = await ClinicService.updateEmailSettings(req.user, req.params.id, gmailAppEmail, gmailAppPassword);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Updated Clinic Email Settings !!',
        success: true,
        data: result,
    })
})

export const ClinicController = {
    getAllClinics,
    getClinicBySlug,
    updateEmailSettings,
}
