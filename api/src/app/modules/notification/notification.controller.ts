import { Request, Response } from 'express';
import catchAsync from '../../../shared/catchAsync';
import sendResponse from '../../../shared/sendResponse';
import { NotificationService } from './notification.service';

const getNotifications = catchAsync(async (req: Request, res: Response) => {
    const result = await NotificationService.getNotifications(req.user, {
        status: req.query.status as string | undefined,
        recipientId: req.query.recipientId as string | undefined,
    });
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved notifications !!',
        success: true,
        data: result
    })
})

const getNotificationById = catchAsync(async (req: Request, res: Response) => {
    const result = await NotificationService.getNotificationById(req.user, req.params.id);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved notification !!',
        success: true,
        data: result
    })
})

const retryNotification = catchAsync(async (req: Request, res: Response) => {
    const result = await NotificationService.retryNotification(req.user, req.params.id);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retried notification !!',
        success: true,
        data: result
    })
})

export const NotificationController = {
    getNotifications,
    getNotificationById,
    retryNotification,
}
