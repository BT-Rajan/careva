import { Reviews } from "@prisma/client";
import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import calculatePagination, { IOption } from "../../../shared/paginationHelper";
import { assertValidReviewTransition } from "./review-lifecycle";

// Pass 21 — Admin & Operational Controls. Closes Gap G8: reviews used to be created and
// immediately, permanently visible to everyone with no moderation step at all. New
// reviews now start SUBMITTED — invisible everywhere except the admin moderation queue
// (getAllReviewsForAdmin) — until an admin explicitly publishes them. See
// review-lifecycle.ts for the full transition graph and schema.prisma's ReviewStatus
// comment for why the column itself still defaults to PUBLISHED (that default is for
// pre-existing/out-of-band rows, not this path).
const create = async (user: any, payload: Reviews): Promise<Reviews> => {
    const isUserExist = await prisma.patient.findUnique({
        where: {
            id: user.userId
        }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient Account is not found !!')
    }
    const isDoctorExist = await prisma.doctor.findUnique({
        where: {
            id: payload.doctorId
        }
    })
    if(isUserExist){
        payload.patientId = isUserExist.id;
    }
    if (!isDoctorExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    // Pass 21 — partial fix for Gap G3 (docs/passes/01-domain-state-model.md). Pass 2's
    // own note left "require appointmentId for new reviews" as an application-layer
    // decision for this pass to make — but the only real frontend review-creation flow
    // (Doctor/DoctorProfile/Review.jsx, reachable from any doctor's public profile) has
    // never collected or sent one; there's no "which of your appointments is this
    // review about" UI anywhere in this app. Requiring it here outright would break
    // every real review submission with no corresponding frontend fix, which is a
    // larger feature (build that picker) than this pass's actual charter (moderation).
    // What IS enforced: if an appointmentId is supplied (by a future frontend, or a
    // direct API caller), it must actually belong to this patient and this doctor —
    // closing the spoofing gap without requiring a capability the app doesn't have yet.
    if (payload.appointmentId) {
        const appointment = await prisma.appointments.findUnique({ where: { id: payload.appointmentId } });
        if (!appointment || appointment.patientId !== isUserExist.id || appointment.doctorId !== isDoctorExist.id) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'This appointment does not belong to you and this doctor !!');
        }
    }
    const result = await prisma.reviews.create({
        data: { ...payload, status: 'SUBMITTED' }
    })
    return result
}

// Pass 21: public listing — PUBLISHED only. This is the "no auth required, anyone
// browsing can see reviews" endpoint; a SUBMITTED (unmoderated, possibly false or
// abusive) or FLAGGED review must never be visible here.
const getAllReviews = async (options: IOption): Promise<Reviews[] | null> => {
    const limit = Number(options.limit) || 10;
    const result = await prisma.reviews.findMany({
        take: limit,
        where: { status: 'PUBLISHED' },
        include: {
            doctor: {
                select: {
                    firstName: true,
                    lastName: true,
                    img: true
                }
            },
            patient: {
                select: {
                    firstName: true,
                    lastName: true,
                    img: true
                }
            }
        }
    });
    return result;
}

// Pass 21 — admin moderation queue. Same pattern as Pass 10's
// getAllDoctorsForAdmin/GET /admin/all: the public listing above filters to
// PUBLISHED, this sees every status so an admin actually has something to moderate.
const getAllReviewsForAdmin = async (reqUser: any, options: IOption): Promise<Reviews[] | null> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can view the review moderation queue !!');
    }
    const limit = Number(options.limit) || 50;
    const result = await prisma.reviews.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
            doctor: { select: { firstName: true, lastName: true, img: true } },
            patient: { select: { firstName: true, lastName: true, img: true } }
        }
    });
    return result;
}

const getSingleReview = async (id: string): Promise<Reviews | null> => {
    const result = await prisma.reviews.findUnique({
        where: {
            id: id
        },
        include: {
            doctor: {
                select: {
                    firstName: true,
                    lastName: true
                }
            },
            patient: {
                select: {
                    firstName: true,
                    lastName: true
                }
            }
        }
    });
    // Pass 21: a direct-by-id fetch is still a public, unauthenticated endpoint (see
    // reviews.route.ts) — an unpublished review's id shouldn't become readable just
    // because someone knows/guesses it.
    if (result && result.status !== 'PUBLISHED') {
        return null;
    }
    return result;
}

const getDoctorReviews = async (id: string): Promise<Reviews[] | null> => {
    const isUserExist = await prisma.doctor.findUnique({
        where: {
            id: id
        }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    // Pass 21: this route allows both DOCTOR and PATIENT callers (see reviews.route.ts)
    // — its real use is a patient browsing a doctor's profile before booking, which is
    // exactly where showing unmoderated content matters most. Filtered to PUBLISHED
    // regardless of caller role; a doctor wanting visibility into their own
    // pending/flagged reviews would need a separate view — not something any current
    // UI asks for, so not built here.
    const result = await prisma.reviews.findMany({
        where: {
            doctorId: isUserExist.id,
            status: 'PUBLISHED'
        },
        include: {
            doctor: {
                select: {
                    firstName: true,
                    lastName: true
                }
            },
            patient: {
                select: {
                    firstName: true,
                    lastName: true
                }
            }
        }
    });
    return result;
}

const deleteReviews = async (id: string): Promise<Reviews> => {
    const result = await prisma.reviews.delete({
        where: {
            id: id
        }
    });
    return result;
}

const updateReview = async (id: string, payload: Partial<Reviews>): Promise<Reviews> => {
    const result = await prisma.reviews.update({
        data: payload,
        where: {
            id: id
        }
    })
    return result;
}

const replyReviewByDoctor = async (user: any, id: string, payload: Partial<Reviews>): Promise<Reviews> => {
    const isUserExist = await prisma.doctor.findUnique({
        where: {
            id: user.userId
        }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    // Pass 4: previously no ownership check — any doctor could reply to ANY review, not
    // just reviews of themselves.
    const review = await prisma.reviews.findUnique({ where: { id } });
    if (!review) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Review is not found !!');
    }
    if (review.doctorId !== user.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to reply to this review !!');
    }

    const result = await prisma.reviews.update({
        data: {
            response: payload.response
        },
        where: {
            id: id
        }
    })
    return result;
}

// Pass 21 — the actual moderation actions. All four share one shape: read current
// status, check the transition via review-lifecycle.ts, write, audit-log it. Modeled
// as one parameterized function rather than four near-identical copies.
const moderateReview = async (reqUser: any, id: string, requestedStatus: 'PUBLISHED' | 'FLAGGED' | 'REMOVED', reason?: string): Promise<Reviews> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can moderate reviews !!');
    }
    const review = await prisma.reviews.findUnique({ where: { id } });
    if (!review) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Review is not found !!');
    }
    assertValidReviewTransition(review.status, requestedStatus, 'admin');
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.reviews.update({ where: { id }, data: { status: requestedStatus } });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: 'admin',
                action: 'review.status_changed',
                entityType: 'Reviews',
                entityId: id,
                metadata: { from: review.status, to: requestedStatus, reason: reason ?? null },
            }
        });
        return updated;
    });
    return result;
}

export const ReviewService = {
    create,
    getAllReviews,
    getAllReviewsForAdmin,
    getDoctorReviews,
    deleteReviews,
    updateReview,
    getSingleReview,
    replyReviewByDoctor,
    moderateReview,
}