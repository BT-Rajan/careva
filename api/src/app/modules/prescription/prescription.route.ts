import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { PrescriptionController } from './prescription.controller';
import validateRequest from '../../middlewares/validateRequest';
import { PrescriptionValidation } from './prescription.validation';

const router = express.Router();

router.get('/doctor/prescription', auth(AuthUser.DOCTOR), PrescriptionController.getDoctorPrescriptionById);
router.get('/patient/prescription', auth(AuthUser.PATIENT), PrescriptionController.getPatientPrescriptionById);

// Pass 4: GET /:id is real (used by doctor Prescription/Treatment views) — restricted to
// authenticated callers, with ownership enforced in the service. GET / (list all) was
// confirmed unused by the frontend and previously had no auth at all — restricted to admin.
router.get('/:id', auth(AuthUser.DOCTOR, AuthUser.PATIENT, AuthUser.ADMIN), PrescriptionController.getPrescriptionById);
router.get('/', auth(AuthUser.ADMIN), PrescriptionController.getAllPrescriptions);

router.post('/create', auth(AuthUser.DOCTOR, AuthUser.ADMIN), validateRequest(PrescriptionValidation.CreatePrescriptionValidation), PrescriptionController.createPrescription);

// Pass 4 BUG FIX: this was `router.delete('/:', ...)` — a route-path typo (missing the
// param name) meant `req.params.id` was always undefined, so delete-prescription — a
// real, frontend-wired feature (Doctor/Prescription/Prescription.jsx) — has been
// non-functional. Pass 13: now soft-deletes (see prescription.service.ts) instead of
// destroying the record outright.
router.delete('/:id', auth(AuthUser.DOCTOR, AuthUser.ADMIN), PrescriptionController.deletePrescription);
router.patch('/:id/restore', auth(AuthUser.ADMIN), PrescriptionController.reactivatePrescription);

// Pass 13 — Prescription & Treatment. Dedicated lifecycle endpoints replacing the old
// generic `PATCH /:id` (which let a client mass-assign `isFullfilled`/`isArchived`
// directly — both now removed from the schema in favor of a real `status` enum, and
// that whole endpoint had been dead code anyway: prescriptionApi.js's matching frontend
// hook was exported under the wrong RTK Query name and was never actually callable).
// See prescription-lifecycle.ts for the transition graph.
router.patch('/:id/fulfill', auth(AuthUser.DOCTOR, AuthUser.PATIENT, AuthUser.ADMIN), PrescriptionController.markPrescriptionFulfilled);
router.patch('/:id/archive', auth(AuthUser.DOCTOR, AuthUser.ADMIN), PrescriptionController.archivePrescription);

router.patch('/update-prescription-appointment', auth(AuthUser.DOCTOR, AuthUser.ADMIN), PrescriptionController.updatePrescriptionAndAppointment);

export const PrescriptionRouter = router;