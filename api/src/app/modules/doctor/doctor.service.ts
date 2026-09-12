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
    // Pass 28 — Multi-Tenant Clinics (query scoping). clinicId is which clinic this
    // doctor is applying to join (validated as required in doctor.validation.ts) — it
    // is NOT a column on Doctor itself, so it's pulled out here before the rest of the
    // payload is written to that table, and used instead to create the DoctorClinic
    // affiliation row (PENDING_APPROVAL, same as approvalStatus always defaulted to
    // pre-Pass-27 — a doctor is not bookable or publicly listed at a clinic until that
    // clinic's admin reviews and approves them).
    const { clinicId, ...doctorPayload } = payload;
    const data = await prisma.$transaction(async (tx) => {
        const { password, ...othersData } = doctorPayload;
        const existEmail = await tx.auth.findUnique({ where: { email: othersData.email } });
        if (existEmail) {
            throw new Error("Email Already Exist !!")
        }
        const clinic = await tx.clinic.findUnique({ where: { id: clinicId } });
        if (!clinic) {
            throw new ApiError(httpStatus.NOT_FOUND, 'Clinic not found !!');
        }
        const doctor = await tx.doctor.create({ data: othersData });
        await tx.doctorClinic.create({ data: { doctorId: doctor.id, clinicId } });
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
//
// Pass 28 — Multi-Tenant Clinics (query scoping). This is the exact function that used
// to let Clinic A's admin list Clinic B's doctors — `approvalStatus` was a plain column
// on Doctor with no tenant boundary at all. It now lives on DoctorClinic (Pass 27), so
// filtering by it means filtering through that relation, and `clinicId` becomes a real
// required-for-admin parameter rather than nothing.
//
// `clinicId` is REQUIRED when `includeAllStatuses` is true (the admin path) — the
// caller (getAllDoctorsForAdmin below) enforces this from the admin's own token, not
// from anything the client can supply, which is what actually closes the leak.
// `clinicId` stays OPTIONAL for the public path: the product decision here is one
// shared public doctor directory across all clinics (with individual per-doctor pages),
// not a clinic-siloed public site — see docs/passes/27-multi-tenant-clinics.md. Pass
// `clinicId` on the public path too if/when a clinic wants its own filtered directory
// page; the plumbing already supports it.
const getAllDoctors = async (filters: IDoctorFilters, options: IOption, includeAllStatuses: boolean = false, clinicId?: string): Promise<IGenericResponse<Doctor[]>> => {
    if (includeAllStatuses && !clinicId) {
        // Defensive: this path should only ever be reached via getAllDoctorsForAdmin,
        // which always supplies clinicId from the caller's own token. A missing
        // clinicId here would mean "show every doctor at every clinic" — refuse instead
        // of silently doing that.
        throw new ApiError(httpStatus.FORBIDDEN, 'Clinic context is required for this listing !!');
    }

    const { limit, page, skip } = calculatePagination(options);
    const { searchTerm, max, min, specialist, ...filterData } = filters;

    const andCondition: any[] = [];
    if (clinicId) {
        andCondition.push({
            clinics: {
                some: includeAllStatuses
                    ? { clinicId }
                    : { clinicId, approvalStatus: 'APPROVED' as const },
            },
        });
    } else if (!includeAllStatuses) {
        // No clinicId given on the public path: still only ever show a doctor who is
        // APPROVED at at least one clinic — never an unreviewed or rejected doctor.
        andCondition.push({ clinics: { some: { approvalStatus: 'APPROVED' as const } } });
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
    // Pass 30 — Multi-Tenant Clinics (frontend wiring). The admin table needs the
    // affiliation's approvalStatus, which no longer lives directly on Doctor (Pass 27).
    // Scoped to the SAME clinicId already used to filter above — an admin should only
    // ever see their own clinic's affiliation row, never another clinic's, even in this
    // nested include. On the public (no clinicId) path, restricted to APPROVED only —
    // a doctor's PENDING/REJECTED/SUSPENDED standing at some OTHER clinic is not public
    // information, even though this same doctor is legitimately listed here via a
    // different, APPROVED affiliation.
    const result = await prisma.doctor.findMany({
        skip,
        take: limit,
        where: whereCondition,
        include: {
            clinics: clinicId ? { where: { clinicId } } : { where: { approvalStatus: 'APPROVED' } },
        },
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

// Pass 30 — Multi-Tenant Clinics (frontend wiring). This is what the individual doctor
// page (and the booking flow reading from it — see SelectApppointment.jsx) actually
// fetches. Without `clinics` included, the frontend has no way to know which clinicId
// to book this doctor at, or to detect the (currently unhandled — see that component's
// comment) case of a doctor affiliated with more than one clinic. Same APPROVED-only
// restriction as the public listing above, for the same reason.
const getDoctor = async (id: string): Promise<Doctor | null> => {
    const result = await prisma.doctor.findUnique({
        where: {
            id: id
        },
        include: {
            clinics: { where: { approvalStatus: 'APPROVED' } },
        },
    });
    return result;
}

// Pass 28 — Multi-Tenant Clinics (query scoping). This is the fix: clinicId now comes
// from the CALLER (doctor.controller.ts, sourced from req.user.clinicId — the admin's
// own token), never from a query param the client controls. A super_admin caller may
// still pass no clinicId at all to intentionally see every clinic's doctors, since
// they're the one role designed to be cross-clinic — see docs/passes/
// 27-multi-tenant-clinics.md's JWT table.
const getAllDoctorsForAdmin = async (filters: IDoctorFilters, options: IOption, clinicId?: string): Promise<IGenericResponse<Doctor[]>> => {
    return getAllDoctors(filters, options, true, clinicId);
}

// Pass 4: previously any authenticated doctor could delete ANY doctor's account by
// supplying a different id — no ownership check at all. Now: self, super_admin, or an
// admin removing the doctor from THEIR OWN clinic specifically.
//
// Pass 28 — Multi-Tenant Clinics (query scoping). A regular 'admin' deleting a doctor
// used to delete the entire global Doctor account — which, now that one doctor can be
// affiliated with several clinics, would be Clinic A unilaterally destroying a doctor's
// standing at Clinic B too. An admin now only ever removes their OWN clinic's
// DoctorClinic affiliation; the Doctor account itself (and any other clinic's
// affiliation) is untouched. Only the doctor themself or a super_admin can delete the
// whole account.
const deleteDoctor = async (reqUser: any, id: string): Promise<any> => {
    const isSuperAdmin = reqUser?.role === 'super_admin';
    const isAdmin = reqUser?.role === 'admin';
    const isSelf = reqUser?.userId === id;

    if (!isSuperAdmin && !isAdmin && !isSelf) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to delete this doctor account !!");
    }

    if (isAdmin && !isSelf) {
        const affiliation = await prisma.doctorClinic.findUnique({
            where: { doctorId_clinicId: { doctorId: id, clinicId: reqUser.clinicId } },
        });
        if (!affiliation) {
            // Deliberately the same 403 as "not allowed" rather than a 404 — an admin
            // should not be able to distinguish "doctor doesn't exist" from "doctor
            // exists but isn't at my clinic" by response shape.
            throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to delete this doctor account !!");
        }
        await prisma.doctorClinic.delete({
            where: { doctorId_clinicId: { doctorId: id, clinicId: reqUser.clinicId } },
        });
        return affiliation;
    }

    // Self or super_admin: the whole account really is going away, everywhere.
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
        return patient;
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
    const isSuperAdmin = reqUser?.role === 'super_admin';
    const isAdmin = reqUser?.role === 'admin';

    // Pass 4: previously any authenticated doctor could update ANY doctor's profile by
    // supplying a different id — no ownership check at all.
    if (!isSuperAdmin && !isAdmin && reqUser?.userId !== id) {
        throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to update this doctor account !!");
    }
    // Pass 28 — Multi-Tenant Clinics (query scoping). An 'admin' (as opposed to
    // super_admin) may only edit a doctor who is actually affiliated with their own
    // clinic — otherwise Clinic A's admin could edit Clinic B's doctor's public
    // profile, which is the same shape of leak as the listing endpoint had.
    if (isAdmin) {
        const affiliation = await prisma.doctorClinic.findUnique({
            where: { doctorId_clinicId: { doctorId: id, clinicId: reqUser.clinicId } },
        });
        if (!affiliation) {
            throw new ApiError(httpStatus.FORBIDDEN, "You are not allowed to update this doctor account !!");
        }
    }

    for (const field of DOCTOR_PROTECTED_FIELDS) {
        if (field === 'verified' && (isAdmin || isSuperAdmin)) continue;
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
//
// Pass 28 — Multi-Tenant Clinics (query scoping). Now operates on the DoctorClinic
// row for (doctorId, clinicId), not a global Doctor field — see Pass 27. `clinicId`
// is resolved by the controller from the actor's own token/request (never trusted
// blindly here either — re-checked below against the actor's actual permissions).
const updateApprovalStatus = async (reqUser: any, doctorId: string, clinicId: string | undefined, requestedStatus: string, reason?: string): Promise<Doctor> => {
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isSuperAdmin = reqUser?.role === 'super_admin';
    const isSelf = reqUser?.userId === doctorId;
    if (!isAdmin && !isSuperAdmin && !isSelf) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to change this doctor account\'s approval status !!');
    }
    // An 'admin' actor may only ever act on their own clinic — even though the
    // controller already sources clinicId from their token rather than the client,
    // this re-check is what actually enforces it at the service layer, in case this
    // function is ever called from somewhere else that isn't as careful.
    if (isAdmin && clinicId !== reqUser?.clinicId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to change this doctor\'s approval status at a different clinic !!');
    }
    if (!clinicId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'clinicId is required !!');
    }

    const affiliation = await prisma.doctorClinic.findUnique({
        where: { doctorId_clinicId: { doctorId, clinicId } },
    });
    if (!affiliation) {
        throw new ApiError(httpStatus.NOT_FOUND, 'This doctor is not affiliated with that clinic !!');
    }

    const actorRole: DoctorActorRole = (isAdmin || isSuperAdmin) ? 'admin' : 'doctor';
    assertValidDoctorApprovalTransition(affiliation.approvalStatus, requestedStatus as any, actorRole);

    if (requestedStatus === 'APPROVED') {
        const { complete, missing } = getProfileCompleteness(doctor);
        if (!complete) {
            throw new ApiError(httpStatus.BAD_REQUEST, `Cannot approve — profile is incomplete. Missing: ${missing.join(', ')}.`);
        }
    }

    const result = await prisma.$transaction(async (tx) => {
        await tx.doctorClinic.update({
            where: { doctorId_clinicId: { doctorId, clinicId } },
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
                entityType: 'DoctorClinic',
                entityId: `${doctorId}:${clinicId}`,
                metadata: { from: affiliation.approvalStatus, to: requestedStatus, reason: reason ?? null, clinicId },
            }
        });
        // updateApprovalStatus's callers/response shape expect a Doctor back (the
        // profile itself doesn't change here — only the affiliation does) — re-fetch
        // for a consistent return value.
        return tx.doctor.findUniqueOrThrow({ where: { id: doctorId } });
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