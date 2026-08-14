import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { PrescriptionController } from './prescription.controller';

const router = express.Router();

router.get('/doctor/prescription', auth(AuthUser.DOCTOR), PrescriptionController.getDoctorPrescriptionById);
router.get('/patient/prescription', auth(AuthUser.PATIENT), PrescriptionController.getPatientPrescriptionById);

// Pass 4: GET /:id is real (used by doctor Prescription/Treatment views) — restricted to
// authenticated callers, with ownership enforced in the service. GET / (list all) was
// confirmed unused by the frontend and previously had no auth at all — restricted to admin.
router.get('/:id', auth(AuthUser.DOCTOR, AuthUser.PATIENT, AuthUser.ADMIN), PrescriptionController.getPrescriptionById);
router.get('/', auth(AuthUser.ADMIN), PrescriptionController.getAllPrescriptions);

router.post('/create', auth(AuthUser.DOCTOR, AuthUser.ADMIN), PrescriptionController.createPrescription);

// Pass 4 BUG FIX: this was `router.delete('/:', ...)` — a route-path typo (missing the
// param name) meant `req.params.id` was always undefined, so delete-prescription — a
// real, frontend-wired feature (Doctor/Prescription/Prescription.jsx) — has been
// non-functional. Also fixed PATCH / to actually take :id, matching what the frontend
// mutation already sends (it was calling a URL shape the backend never matched).
router.delete('/:id', auth(AuthUser.DOCTOR, AuthUser.ADMIN), PrescriptionController.deletePrescription);
router.patch('/:id', auth(AuthUser.DOCTOR, AuthUser.ADMIN), PrescriptionController.updatePrescription);
router.patch('/update-prescription-appointment', auth(AuthUser.DOCTOR, AuthUser.ADMIN), PrescriptionController.updatePrescriptionAndAppointment);

export const PrescriptionRouter = router;