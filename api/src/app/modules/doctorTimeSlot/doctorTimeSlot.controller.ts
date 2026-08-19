import { Request, Response } from "express";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { TimeSlotService } from "./doctorTimeSlot.service";
import { DoctorTimeSlot } from "@prisma/client";

const createTimeSlot = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.createTimeSlot(req.user, req.body);
    sendResponse<DoctorTimeSlot>(res, {
        statusCode: 200,
        message: 'Successfully created Time Slot !!',
        success: true,
        data: result
    })
})

const getAllTimeSlot = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.getAllTimeSlot();
    sendResponse<DoctorTimeSlot[]>(res, {
        statusCode: 200,
        message: 'Successfully  get all Time Slot !!',
        success: true,
        data: result
    })
})

const getMyTimeSlot = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.getMyTimeSlot(req.user, req.query);
    sendResponse<DoctorTimeSlot[]>(res, {
        statusCode: 200,
        message: 'Successfully  get all Time Slot !!',
        success: true,
        data: result
    })
})

const getTimeSlot = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.getTimeSlot(req.user, req.params.id);
    sendResponse<DoctorTimeSlot>(res, {
        statusCode: 200,
        message: 'Successfully get Time Slot !!',
        success: true,
        data: result
    })
})

const updateTimeSlot = catchAsync(async (req: Request, res: Response) => {
    await TimeSlotService.updateTimeSlot(req.user, req.params.id, req.body);
    sendResponse<DoctorTimeSlot>(res, {
        statusCode: 200,
        message: 'Successfully updated Time Slot !!',
        success: true,
    })
})

const deleteTimeSlot = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.deleteTimeSlot(req.user, req.params.id);
    sendResponse<DoctorTimeSlot>(res, {
        statusCode: 200,
        message: 'Successfully deleted Time Slot !!',
        success: true,
        data: result
    })
})
const getAppointmentTimeOfEachDoctor = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.getAppointmentTimeOfEachDoctor(req.params.id, req.query);
    sendResponse<DoctorTimeSlot>(res, {
        statusCode: 200,
        message: 'Successfully deleted Time Slot !!',
        success: true,
        data: result
    })
})


const createBlockedDate = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.createBlockedDate(req.user, req.body.date, req.body.reason);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully blocked date !!',
        success: true,
        data: result
    })
})

const deleteBlockedDate = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.deleteBlockedDate(req.user, req.params.id);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully removed blocked date !!',
        success: true,
        data: result
    })
})

const getMyBlockedDates = catchAsync(async (req: Request, res: Response) => {
    const result = await TimeSlotService.getMyBlockedDates(req.user);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved blocked dates !!',
        success: true,
        data: result
    })
})

export const doctorTimeSlotController = {
    getAllTimeSlot,
    getTimeSlot,
    updateTimeSlot,
    createTimeSlot,
    deleteTimeSlot,
    getMyTimeSlot,
    getAppointmentTimeOfEachDoctor,
    createBlockedDate,
    deleteBlockedDate,
    getMyBlockedDates,
}