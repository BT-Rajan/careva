import express from 'express';
import { ClinicController } from './clinic.controller';

const router = express.Router();

// Public — same trust level as doctor directory browsing (GET /doctor). A signup
// picker or booking page needs this before the user has any account at all.
router.get('/', ClinicController.getAllClinics);
router.get('/:slug', ClinicController.getClinicBySlug);

export const ClinicRouter = router;
