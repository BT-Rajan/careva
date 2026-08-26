import express, { NextFunction, Request, Response } from 'express';
import { DoctorController } from './doctor.controller';
import { AuthUser } from '../../../enums';
import { auth } from '../../middlewares/auth';
import { CloudinaryHelper } from '../../../helpers/uploadHelper';
import validateRequest from '../../middlewares/validateRequest';
import { DoctorValidation } from './doctor.validation';

const router = express.Router();

router.get('/', DoctorController.getAllDoctors);
// Pass 10 — Doctor Lifecycle. Admin-only variant of the listing above that includes
// every approval status, for the review queue — the public route now filters to
// APPROVED only (see doctor.service.ts), so admin needs a separate way to see doctors
// still pending review. Registered before /:id so "admin" is never captured as an id.
router.get('/admin/all', auth(AuthUser.ADMIN), DoctorController.getAllDoctorsForAdmin);
router.post('/', validateRequest(DoctorValidation.CreateDoctorValidation), DoctorController.createDoctor);
router.get('/:id', DoctorController.getDoctor);
router.delete('/:id', auth(AuthUser.DOCTOR, AuthUser.ADMIN), DoctorController.deleteDoctor);
router.patch('/:id',
    CloudinaryHelper.upload.single('file'),
    auth(AuthUser.DOCTOR, AuthUser.ADMIN),
    (req: Request, res: Response, next: NextFunction) => {
        return DoctorController.updateDoctor(req, res, next);
    }
);
// Pass 10: dedicated approval-status endpoint — see doctor.service.ts's updateDoctor for
// why approvalStatus is unconditionally rejected on the generic PATCH /:id above.
router.patch('/:id/approval-status', auth(AuthUser.DOCTOR, AuthUser.ADMIN), DoctorController.updateApprovalStatus);

export const DoctorRouter = router;