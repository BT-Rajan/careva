import { Request, Response } from 'express';
import catchAsync from '../../../shared/catchAsync';
import sendResponse from '../../../shared/sendResponse';
import { AuditLogService } from './audit-log.service';

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
    const { data, meta } = await AuditLogService.getAuditLogs(req.user, req.query as any);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved audit log !!',
        success: true,
        meta,
        data,
    })
})

const getAuditLogsForEntity = catchAsync(async (req: Request, res: Response) => {
    const result = await AuditLogService.getAuditLogsForEntity(req.user, req.params.entityType, req.params.entityId);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully retrieved audit log !!',
        success: true,
        data: result,
    })
})

export const AuditLogController = {
    getAuditLogs,
    getAuditLogsForEntity,
}
