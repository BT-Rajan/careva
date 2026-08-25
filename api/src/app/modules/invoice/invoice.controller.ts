import { Request, Response } from 'express';
import catchAsync from '../../../shared/catchAsync';
import sendResponse from '../../../shared/sendResponse';
import { InvoiceService } from './invoice.service';

const getInvoiceByAppointmentId = catchAsync(async (req: Request, res: Response) => {
    const result = await InvoiceService.getInvoiceByAppointmentId(req.user, req.params.appointmentId);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved invoice !!',
        success: true,
        data: result
    })
})

const getInvoiceById = catchAsync(async (req: Request, res: Response) => {
    const result = await InvoiceService.getInvoiceById(req.user, req.params.id);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved invoice !!',
        success: true,
        data: result
    })
})

const getDoctorInvoices = catchAsync(async (req: Request, res: Response) => {
    const result = await InvoiceService.getDoctorInvoices(req.user);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved invoices !!',
        success: true,
        data: result
    })
})

const getPatientInvoices = catchAsync(async (req: Request, res: Response) => {
    const result = await InvoiceService.getPatientInvoices(req.user);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved invoices !!',
        success: true,
        data: result
    })
})

const voidInvoice = catchAsync(async (req: Request, res: Response) => {
    const result = await InvoiceService.voidInvoice(req.user, req.params.id, req.body?.reason);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully voided invoice !!',
        success: true,
        data: result
    })
})

const correctInvoice = catchAsync(async (req: Request, res: Response) => {
    const result = await InvoiceService.correctInvoice(req.user, req.params.id, req.body ?? {});
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully issued corrected invoice !!',
        success: true,
        data: result
    })
})

export const InvoiceController = {
    getInvoiceById,
    getInvoiceByAppointmentId,
    getDoctorInvoices,
    getPatientInvoices,
    voidInvoice,
    correctInvoice,
}
