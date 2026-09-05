import { Doctor, UserRole } from "@prisma/client";
import prisma from "../../../shared/prisma";
import bcrypt from 'bcrypt';
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import { DoctorSearchableFields, IDoctorFilters } from "./doctor.interface";
import calculatePagination, { IOption } from "../../../shared/paginationHelper";
import { IGenericResponse } from "../../../interfaces/common";
import { Request } from "express";
import { IUpload } from "../../../interfaces/file";
import { CloudinaryHelper } from "../../../helpers/uploadHelper";
import moment from "moment";
import * as path from "path";
import config from "../../../config";
import { assertValidDoctorApprovalTransition, getProfileCompleteness, DoctorActorRole } from "./doctor-lifecycle";
import { NotificationService } from "../notification/notification.service";
const { v4: uuidv4 } = require('uuid');

const sendVerificationEmail = async (data: Doctor) => {
    const currentUrl = process.env.NODE_ENV === 'production' ? config.backendLiveUrl : config.backendLocalUrl;
    const uniqueString = uuidv4() + data.id;
    const uniqueStringHashed = await bcrypt.hashSync(uniqueString, 12);
    const url = `${currentUrl}user/verify/${data.id}/${uniqueString}`
    const expiresDate = moment().add(6, 'hours')
    const verficationData = await prisma.userVerfication.create({
        data: {
            userId: data.id,
            expiresAt: expiresDate.toDate(),
            uniqueString: uniqueStringHashed
        }
    })
    if (verficationData) {
        const pathName = path.join(__dirname, '../../../../template/verify.html',)
        const obj = {link: url};
        const subject = "Email Verification"
        const toMail = data.email;
        // Pass 16 BUG FIX: previously `await`ed inside a try/catch that RE-THREW on
        // failure — a flaky mail server would fail the entire doctor-registration
        // request even though, by this point, the doctor's account row was already
        // committed (this function runs after the account-creation transaction — see
        // its caller below). The doctor would see a registration error despite having
        // an account. dispatchNotification never throws and persists the attempt for
        // tracking/retry instead of silently losing it to a console.log.
        await NotificationService.dispatchNotification({
            recipientId: data.id,
            recipientRole: 'doctor',
            recipientEmail: toMail,
            event: 'doctor.verification_email',
            subject,
            pathName,
            replacementObj: obj,
            relatedEntityType: 'Doctor',
            relatedEntityId: data.id,
        });
    }
}

const create = async (payload: any): Promise<any> => {
    // Pass 3: normalize email casing (see identical reasoning in patientService.ts).
    if (typeof payload.email === 'string') {
        payload.email = payload.email.trim().toLowerCase();
    }
    const data = await prisma.$transaction(async (tx) => {
        const { password, ...othersData } = payload;
        const existEmail = await tx.auth.findUnique({ where: { email: othersData.email } });
        if (existEmail) {
            throw new Error("Email Already Exist !!")
        }
        const doctor = await tx.doctor.create({ data: othersData });
        await tx.auth.create({
            data: {
                email: doctor.email,
                password: password && await bcrypt.hashSync(password, 12),
                role: UserRole.doctor,
                userId: doctor.id
            },
        });
        return doctor
    });

    if (data.id) {
        await sendVerificationEmail(data)
    }
    return data;

}

// Pass 10 — Doctor Lifecycle. `includeAllStatuses` is only ever true for the admin-only
// route (doctor.route.ts's GET /admin/all) — the public listing (GET /, used by patient
// doctor search) previously had NO filter on approval status at all, meaning a doctor
// nobody had ever reviewed was fully visible and, per the booking-flow fix in
// appointment.service.ts, fully bookable. Defaulting to false here means every other
// existing caller of this function automatically gets the fix without needing to opt in.
const getAllDoctors = async (filters: IDoctorFilters, options: IOption, includeAllStatuses: boolean = false): Promise<IGenericResponse<Doctor[]>> => {
    const { limit, page, skip } = calculatePagination(options);
    const { searchTerm, max, min, specialist, ...filterData } = filters;

    const andCondition = [];
    if (!includeAllStatuses) {
        andCondition.push({ approvalStatus: 'APPROVED' as const });
    }
    if (searchTerm) {
        andCondition.push({
            OR: DoctorSearchableFields.map((field) => ({
                [field]: {
                    contains: searchTerm
                }
            }))
        })
    }

    if (Object.keys(filterData).length > 0) {
        andCondition.push({
            AND: Object.entries(filterData).map(([key, value]) => ({
                [key]: { equals: value }
            }))
        })
    }

    if (min || max) {
        andCondition.push({
            AND: ({
                price: {
                    gte: min,
                    lte: max
                }
            })
        })
    }

    if (specialist) {
        andCondition.push({
            AND: ({
                services: {
                    contains: specialist
                }
            })
        })
    }

    const whereCondition = andCondition.length > 0 ? { AND: andCondition } : {};
    const result = await prisma.doctor.findMany({
        skip,
        take: limit,
        where: whereCondition,
    });

    const total = await prisma.doctor.count({ where: whereCondition });
    return {
        meta: {
            page,
            limit,
            total,
        },
        data: result
    }
}

const getDoctor = async (id: string): Promise<Doctor | null> => {
    const result = await prisma.doctor.findUnique({
        where: {
            id: id
        }
    });
    return result;
}

const getAllDoctorsForAdmin = async (filters: IDoctorFilters, options: IOption): Promise<IGenericResponse<Doctor[]>> => {
    return getAllDoctors(filters, options, true);
}

const deleteDoctor = async (reqUser: any, id: string): Promise<any> => {
    // Pass 4: previously any authenticated doctor could delete ANY doctor's account by
    // supplying a different id — no ownership check at all. Now: self, or admin.
    const isAdmin = reqUser?.role === 'admin';
    if (!isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to delete this doctor account !!");
    }
    const result = await prisma.$transaction(async (tx) => {
        const patient = await tx.doctor.delete({
            where: {
                id: id
            }
        });
        await tx.auth.delete({
            where: {
                email: patient.email
            }
        })
    });
    return result;
}

// Pass 4: fields no caller may set through this endpoint via ordinary mass-assignment.
// `verified` is the critical one — without this, a doctor could set `verified: true` in
// their own profile-edit payload and self-approve, bypassing admin review entirely. Only
// an admin caller (checked below) may set it.
// Pass 10: approvalStatus and its audit fields are stripped UNCONDITIONALLY — even for
// admin — unlike `verified`. Approval changes must go through updateApprovalStatus
// below, which validates the transition and (for approval specifically) checks profile
// completeness; letting admin set it directly here would bypass both checks. Same
// architectural pattern as Pass 9's cancel-type-transition enforcement on
// updateAppointment.
const DOCTOR_PROTECTED_FIELDS = ['id', 'email', 'createdAt', 'updatedAt', 'deletedAt', 'verified', 'approvalStatus', 'approvalStatusChangedAt', 'approvalStatusChangedBy', 'approvalStatusChangeReason'];

const updateDoctor = async (req: Request): Promise<Doctor> => {
    const file = req.file as IUpload;
    const id = req.params.id as string;
    const user = JSON.parse(req.body.data);
    const reqUser: any = req.user;
    const isAdmin = reqUser?.role === 'admin';

    // Pass 4: previously any authenticated doctor could update ANY doctor's profile by
    // supplying a different id — no ownership check at all.
    if (!isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to update this doctor account !!");
    }

    for (const field of DOCTOR_PROTECTED_FIELDS) {
        if (field === 'verified' && isAdmin) continue;
        delete user[field];
    }

    if (file) {
        const uploadImage = await CloudinaryHelper.uploadFile(file);
        if (uploadImage) {
            user.img = uploadImage.secure_url
        } else {
            throw new ApiError(httpStatus.EXPECTATION_FAILED, 'Failed to Upload Image');
        }
    }
    const result = await prisma.doctor.update({
        where: { id },
        data: user
    })
    return result;
}

// Pass 10 — Doctor Lifecycle. The real admin-review action, replacing the old
// verified-toggle-as-approval conflation. Blocks approving an incomplete profile
// (mirrors the frontend's own onboarding gate — see doctor-lifecycle.ts's comment on
// why this duplication exists) and sends a best-effort notification email on the
// outcomes a doctor would actually want to know about.
const updateApprovalStatus = async (reqUser: any, doctorId: string, requestedStatus: string, reason?: string): Promise<Doctor> => {
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isSelf = reqUser?.userId === doctorId;
    if (!isAdmin && !isSelf) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to change this doctor account\'s approval status !!');
    }
    const actorRole: DoctorActorRole = isAdmin ? 'admin' : 'doctor';
    assertValidDoctorApprovalTransition(doctor.approvalStatus, requestedStatus as any, actorRole);

    if (requestedStatus === 'APPROVED') {
        const { complete, missing } = getProfileCompleteness(doctor);
        if (!complete) {
            throw new ApiError(httpStatus.BAD_REQUEST, `Cannot approve — profile is incomplete. Missing: ${missing.join(', ')}.`);
        }
    }

    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.doctor.update({
            where: { id: doctorId },
            data: {
                approvalStatus: requestedStatus as any,
                approvalStatusChangedAt: new Date(),
                approvalStatusChangedBy: reqUser?.userId,
                approvalStatusChangeReason: reason,
            }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'doctor.approval_status_changed',
                entityType: 'Doctor',
                entityId: doctorId,
                metadata: { from: doctor.approvalStatus, to: requestedStatus, reason: reason ?? null },
            }
        });
        return updated;
    });

    if (['APPROVED', 'REJECTED', 'SUSPENDED'].includes(requestedStatus) && result.email) {
        // Pass 10 flagged reusing template/appointment.html for this as not ideal ("A
        // proper template is Pass 16's job"). doctorStatus.html is that dedicated
        // template — same handlebars replacement-object mechanism, shaped for an
        // account-status notice instead of an appointment's own fields.
        const HEADLINE_BY_STATUS: Record<string, string> = {
            APPROVED: 'Your profile has been approved',
            REJECTED: 'An update on your application',
            SUSPENDED: 'Your account has been suspended',
        };
        const BODY_BY_STATUS: Record<string, string> = {
            APPROVED: 'Great news — your Careva profile has been reviewed and approved. Patients can now find and book appointments with you.',
            REJECTED: 'After reviewing your application, we are unable to approve your Careva profile at this time.',
            SUSPENDED: 'Your Careva account has been suspended. You will not be able to accept new bookings while this is in effect.',
        };
        const subject = { APPROVED: 'Your Careva profile has been approved', REJECTED: 'Update on your Careva application', SUSPENDED: 'Your Careva account has been suspended' }[requestedStatus] as string;
        const pathName = path.join(__dirname, '../../../../template/doctorStatus.html');
        // Pass 16: previously already `.catch()`-guarded (so not a crash risk), but left
        // no record of whether the doctor was ever actually notified of their own
        // account's status change — exactly the kind of event worth tracking.
        NotificationService.dispatchNotification({
            recipientId: doctorId,
            recipientRole: 'doctor',
            recipientEmail: result.email,
            event: 'doctor.approval_status_changed',
            subject,
            pathName,
            replacementObj: {
                headline: HEADLINE_BY_STATUS[requestedStatus],
                doctorFirstName: result.firstName,
                doctorLastName: result.lastName,
                bodyText: BODY_BY_STATUS[requestedStatus],
                reason: reason ?? undefined,
            },
            relatedEntityType: 'Doctor',
            relatedEntityId: doctorId,
        }).catch((err) => console.error('Failed to dispatch doctor approval-status notification:', err));
    }

    return result;
}

export const DoctorService = {
    create,
    updateDoctor,
    updateApprovalStatus,
    deleteDoctor,
    getAllDoctors,
    getAllDoctorsForAdmin,
    getDoctor
}