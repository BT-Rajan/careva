import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { AuditLogController } from './audit-log.controller';

const router = express.Router();

router.get('/', auth(AuthUser.ADMIN), AuditLogController.getAuditLogs);
router.get('/:entityType/:entityId', auth(AuthUser.ADMIN), AuditLogController.getAuditLogsForEntity);

export const AuditLogRouter = router;
