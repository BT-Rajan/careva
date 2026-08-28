import express from 'express';
import { ReviewController } from './reviews.controller';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';

const router = express.Router();
// Pass 21 — Admin & Operational Controls. Registered before /:id so "admin" is never
// captured as an id — same convention as doctor.route.ts's /admin/all.
router.get('/admin/all', auth(AuthUser.ADMIN), ReviewController.getAllReviewsForAdmin);
router.get('/doctor-review/:id', auth(AuthUser.DOCTOR, AuthUser.PATIENT), ReviewController.getDoctorReviews);
router.get('/:id', ReviewController.getSingleReview);
router.post('/', auth(AuthUser.PATIENT), ReviewController.creatReview);
router.get('/', ReviewController.getAllReview);
router.delete('/:id', auth(AuthUser.ADMIN), ReviewController.deleteReview);
router.patch('/:id/reply', auth(AuthUser.DOCTOR), ReviewController.replyReviewByDoctor);
router.patch('/:id', auth(AuthUser.ADMIN), ReviewController.updateReview);
// Pass 21 — the actual moderation actions (review-lifecycle.ts).
router.patch('/:id/publish', auth(AuthUser.ADMIN), ReviewController.publishReview);
router.patch('/:id/flag', auth(AuthUser.ADMIN), ReviewController.flagReview);
router.patch('/:id/remove', auth(AuthUser.ADMIN), ReviewController.removeReview);

export const ReviewRouter = router;