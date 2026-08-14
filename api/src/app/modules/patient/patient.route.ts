import express, { NextFunction, Request, Response } from 'express';
import { PatientController } from './patient.controller';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { CloudinaryHelper } from '../../../helpers/uploadHelper';

const router = express.Router();

// Pass 4: previously GET / (list all), GET /:id, and DELETE /:id had no auth middleware
// at all — full patient PII was readable/deletable by anyone. GET / is real (used by the
// admin dashboard); GET /:id and DELETE /:id are confirmed unused by the frontend today,
// but were still live, reachable, unauthenticated endpoints.
router.get('/', auth(AuthUser.ADMIN), PatientController.getAllPatients);
router.post('/', PatientController.createPatient);
router.get('/:id', auth(AuthUser.ADMIN, AuthUser.PATIENT), PatientController.getPatient);
router.delete('/:id', auth(AuthUser.ADMIN), PatientController.deletePatient);
router.patch('/:id',
    CloudinaryHelper.upload.single('file'),
    auth(AuthUser.PATIENT, AuthUser.ADMIN),
    (req: Request, res: Response, next: NextFunction) => {
        return PatientController.updatePatient(req, res, next)
    }
);

export const PatientRouter = router;