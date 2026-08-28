import { Request, Response } from "express";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { Reviews } from "@prisma/client";
import { ReviewService } from "./reviews.service";
import pick from "../../../shared/pick";

const creatReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.create(req.user, req.body);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully review Created !!',
        success: true,
        data: result
    })
})

const getAllReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.getAllReviews(req.query);
    sendResponse<Reviews[]>(res, {
        statusCode: 200,
        message: 'Successfully Retrieve review !!',
        success: true,
        data: result,
    })
})

const getSingleReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.getSingleReview(req.params.id as string);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully Retrieve review !!',
        success: true,
        data: result,
    })
})

const getDoctorReviews = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.getDoctorReviews(req.params.id);
    sendResponse<Reviews[]>(res, {
        statusCode: 200,
        message: 'Successfully Retrieve review !!',
        success: true,
        data: result,
    })
})


const deleteReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.deleteReviews(req.params.id);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully Deleted review !!',
        success: true,
        data: result,
    })
})

const updateReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.updateReview(req.params.id, req.body);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully Updated review !!',
        success: true,
        data: result,
    })
})

const replyReviewByDoctor = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.replyReviewByDoctor(req.user, req.params.id, req.body);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully Reply review !!',
        success: true,
        data: result,
    })
})

const getAllReviewsForAdmin = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.getAllReviewsForAdmin(req.user, req.query);
    sendResponse<Reviews[]>(res, {
        statusCode: 200,
        message: 'Successfully Retrieve review moderation queue !!',
        success: true,
        data: result,
    })
})

const publishReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.moderateReview(req.user, req.params.id, 'PUBLISHED', req.body?.reason);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully Published review !!',
        success: true,
        data: result,
    })
})

const flagReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.moderateReview(req.user, req.params.id, 'FLAGGED', req.body?.reason);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully Flagged review !!',
        success: true,
        data: result,
    })
})

const removeReview = catchAsync(async (req: Request, res: Response) => {
    const result = await ReviewService.moderateReview(req.user, req.params.id, 'REMOVED', req.body?.reason);
    sendResponse<Reviews>(res, {
        statusCode: 200,
        message: 'Successfully Removed review !!',
        success: true,
        data: result,
    })
})

export const ReviewController = {
    creatReview,
    updateReview,
    getAllReview,
    getAllReviewsForAdmin,
    getDoctorReviews,
    deleteReview,
    getSingleReview,
    replyReviewByDoctor,
    publishReview,
    flagReview,
    removeReview,
}