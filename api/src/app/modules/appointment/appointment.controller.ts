import { Request, Response } from "express";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { AppointmentService } from "./appointment.service";
import { Appointments, Patient } from "@prisma/client";

const createAppointment = catchAsync(async (req: Request, res: Response) => {
    // Pass 6: optional client-supplied key for duplicate-submission protection (double
    // click, retry-after-timeout). Absent header = no idempotency protection for that
    // request, same as before this pass — this is additive, not a breaking requirement.
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const result = await AppointmentService.createAppointment(req.body, idempotencyKey);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Appointment Created !!',
        success: true,
        data: result
    })
})
const createAppointmentByUnAuthenticateUser = catchAsync(async (req: Request, res: Response) => {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const result = await AppointmentService.createAppointmentByUnAuthenticateUser(req.body, idempotencyKey);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Appointment Created !!',
        success: true,
        data: result
    })
})


const getAllAppointment = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.getAllAppointments();
    sendResponse<Appointments[]>(res, {
        statusCode: 200,
        message: 'Successfully Retrieve All Appointment !!',
        success: true,
        data: result,
    })
})

const getAppointment = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.getAppointment(req.user, req.params.id);
    sendResponse<Appointments>(res, {
        statusCode: 200,
        message: 'Successfully Get Appointment !!',
        success: true,
        data: result,
    })
})

const getAppointmentByTrackingId = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.getAppointmentByTrackingId(req.body);
    sendResponse<Appointments>(res, {
        statusCode: 200,
        message: 'Successfully Get Appointment !!',
        success: true,
        data: result,
    })
})

const deleteAppointment = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.deleteAppointment(req.params.id);
    sendResponse<Appointments>(res, {
        statusCode: 200,
        message: 'Successfully Deleted Appointment !!',
        success: true,
        data: result,
    })
})

const updateAppointment = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.updateAppointment(req.user, req.params.id, req.body);
    sendResponse<Appointments>(res, {
        statusCode: 200,
        message: 'Successfully Updated Appointment !!',
        success: true,
        data: result,
    })
})

const cancelAppointment = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.cancelAppointment(req.user, req.params.id, req.body?.reason);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Cancelled Appointment !!',
        success: true,
        data: result,
    })
})

const rescheduleAppointment = catchAsync(async (req: Request, res: Response) => {
    const { scheduleDate, scheduleTime, reason } = req.body;
    const result = await AppointmentService.rescheduleAppointment(req.user, req.params.id, scheduleDate, scheduleTime, reason);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Rescheduled Appointment !!',
        success: true,
        data: result,
    })
})

const getPatientAppointmentById = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.getPatientAppointmentById(req.user);
    sendResponse<Appointments[]>(res, {
        statusCode: 200,
        message: 'Successfully Updated Appointment !!',
        success: true,
        data: result,
    })
})

const getDoctorAppointmentsById = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.getDoctorAppointmentsById(req.user, req.query);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Retrieve doctor apppointments !!',
        success: true,
        data: result
    })
})

const updateAppointmentByDoctor = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.updateAppointmentByDoctor(req.user, req.body);
    sendResponse<Appointments>(res, {
        statusCode: 200,
        message: 'Successfully updated apppointments !!',
        success: true,
        data: result
    })
})

const getDoctorPatients = catchAsync(async (req: Request, res: Response) => {
    const result = await AppointmentService.getDoctorPatients(req.user);
    sendResponse<Patient[]>(res, {
        statusCode: 200,
        message: 'Successfully retrieve doctor patients !!',
        success: true,
        data: result
    })
})

export const AppointmentController = {
    getDoctorAppointmentsById,
    updateAppointmentByDoctor,
    getPatientAppointmentById,
    updateAppointment,
    cancelAppointment,
    rescheduleAppointment,
    createAppointment,
    getAllAppointment,
    getAppointment,
    deleteAppointment,
    getDoctorPatients,

    createAppointmentByUnAuthenticateUser,
    getAppointmentByTrackingId
}