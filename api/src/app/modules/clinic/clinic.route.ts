import express from 'express';
import { ClinicController } from './clinic.controller';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';

const router = express.Router();

// Public — same trust level as doctor directory browsing (GET /doctor). A signup
// picker or booking page needs this before the user has any account at all.
router.get('/', ClinicController.getAllClinics);
router.get('/:slug', ClinicController.getClinicBySlug);

// Pass 31 — Multi-Tenant Clinics (per-clinic email). Admin-only, scoped to the caller's
// own clinic (or any clinic for super_admin) — see clinic.service.ts's
// updateEmailSettings for the ownership check.
router.patch('/:id/email-settings', auth(AuthUser.ADMIN, AuthUser.SUPER_ADMIN), ClinicController.updateEmailSettings);

export const ClinicRouter = router;
