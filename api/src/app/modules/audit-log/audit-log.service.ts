/**
 * Pass 22 — Audit & Observability.
 *
 * Passes 8 through 21 have all faithfully written to AuditLog on every significant
 * state change (appointment transitions, doctor approval decisions, prescription
 * corrections, invoice lifecycle, notification dispatch, payment reconciliation,
 * review moderation...) — but until this pass, nothing anywhere could actually READ
 * any of it back. An audit trail nobody can query is not serving the purpose an audit
 * trail exists for. This module is the missing other half: admin-only, filterable,
 * paginated access to everything every other pass has been recording.
 */
import httpStatus from 'http-status';
import ApiError from '../../../errors/apiError';
import prisma from '../../../shared/prisma';
import { AuditLog, Prisma } from '@prisma/client';

export interface AuditLogFilters {
    entityType?: string;
    entityId?: string;
    actorId?: string;
    action?: string;
    from?: string;
    to?: string;
    page?: string | number;
    limit?: string | number;
}

const getAuditLogs = async (reqUser: any, filters: AuditLogFilters): Promise<{ data: AuditLog[]; meta: { page: number; limit: number; total: number } }> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can view the audit log !!');
    }
    const page = Math.max(1, Number(filters.page) || 1);
    // Capped, not just defaulted — this table is expected to grow indefinitely (it's
    // append-only by every other pass's design), so an unbounded `limit` from the query
    // string could turn one request into a full table scan.
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));

    const where: Prisma.AuditLogWhereInput = {
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
        ...(filters.actorId ? { actorId: filters.actorId } : {}),
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.from || filters.to ? {
            createdAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
            }
        } : {}),
    };

    const [data, total] = await Promise.all([
        prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.auditLog.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
}

// Pass 22 — a focused shortcut for the single most common real investigation: "show me
// everything that ever happened to this one record" (one appointment, one payment, one
// doctor's approval history). Equivalent to getAuditLogs with entityType+entityId
// filters, but a dedicated endpoint reads more naturally from an entity's own admin
// detail view than requiring the caller to know AuditLog's filter query-param names.
const getAuditLogsForEntity = async (reqUser: any, entityType: string, entityId: string): Promise<AuditLog[]> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can view the audit log !!');
    }
    return prisma.auditLog.findMany({
        where: { entityType, entityId },
        orderBy: { createdAt: 'desc' },
    });
}

export const AuditLogService = {
    getAuditLogs,
    getAuditLogsForEntity,
}
