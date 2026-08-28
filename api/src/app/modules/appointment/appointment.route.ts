import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { AppointmentController } from './appointment.controller';
import validateRequest from '../../middlewares/validateRequest';
import { AppointmentValidation } from './appointment.validation';
import { appointmentCreateRateLimiter, trackAppointmentRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

// Pass 4: GET / previously had no auth at all — every appointment's PII/PHI was
// listable by anyone. It's genuinely used (admin dashboard, via adminApi.js's
// getAllAppointments), so it's restricted to admin rather than removed.
router.get('/', auth(AuthUser.ADMIN), AppointmentController.getAllAppointment);

router.get('/patient/appointments',auth(AuthUser.PATIENT), AppointmentController.getPatientAppointmentById);

router.get('/doctor/appointments',auth(AuthUser.DOCTOR), AppointmentController.getDoctorAppointmentsById);
router.get('/doctor/patients',auth(AuthUser.DOCTOR), AppointmentController.getDoctorPatients);

// Pass 14 — Invoice & Financial Records: these three routes (patient/invoices,
// doctor/invoices, patient-payment-info/:id) are REMOVED, not just left unused. They
// rendered a raw Payment row labeled as an "invoice" — exactly Gap G7
// (docs/passes/01-domain-state-model.md): "No persisted Invoice entity; 'invoice' is a
// client-side render only." Now that a real Invoice entity exists (see
// api/src/app/modules/invoice/), the equivalent — and only — endpoints are
// GET /invoice/patient, GET /invoice/doctor, and GET /invoice/appointment/:appointmentId.
// getPatientPaymentInfo was confirmed unused by any frontend component even before this
// removal; getDoctorInvoices and getPaymentInfoViaAppintmentId were live (DoctorInvoice.jsx,
// Doctor/Dashboard/Dashboard.jsx, BookingInvoice.jsx) and have been repointed to the new
// endpoints in the same commit as this removal.

// Pass 15 — Tracking & Public Access. Deliberately public: this is the app's real
// public-tracking surface (TrackAppointment.jsx and BookingSuccess.jsx), keyed by
// trackingId — a cryptographically random token (see shared/trackingId.ts), not the raw
// database id. See AppointmentService.getAppointmentByTrackingId for the deliberately
// curated (not "every column") response shape this returns.
router.post('/tracking', trackAppointmentRateLimiter, validateRequest(AppointmentValidation.TrackAppointmentValidation), AppointmentController.getAppointmentByTrackingId);
router.post('/create', appointmentCreateRateLimiter, validateRequest(AppointmentValidation.CreateAppointmentValidation), AppointmentController.createAppointment);
router.post('/create-un-authenticate', appointmentCreateRateLimiter, validateRequest(AppointmentValidation.CreateAppointmentByUnAuthenticateUserValidation), AppointmentController.createAppointmentByUnAuthenticateUser);

// Pass 15 — Tracking & Public Access: now requires auth + ownership (see
// AppointmentService.getAppointment). The one legitimate unauthenticated use this
// endpoint used to serve — BookingSuccess.jsx's guest post-booking confirmation — now
// goes through POST /tracking (trackingId is a real random token — see
// shared/trackingId.ts — making that endpoint's public reachability the correct design,
// not a gap).
router.get('/:id', auth(AuthUser.PATIENT, AuthUser.DOCTOR, AuthUser.ADMIN), AppointmentController.getAppointment);

// Pass 4: previously no auth at all — anyone could destroy any appointment record.
// Confirmed unused by the frontend today (no delete-appointment UI exists anywhere).
router.delete('/:id', auth(AuthUser.ADMIN), AppointmentController.deleteAppointment);
router.patch('/:id', auth(AuthUser.ADMIN, AuthUser.DOCTOR, AuthUser.PATIENT),AppointmentController.updateAppointment);
// Pass 9 — Cancellation & Rescheduling. Dedicated endpoints, deliberately separate from
// the generic PATCH /:id above — see appointment.service.ts's updateAppointment for why
// cancel-type transitions are blocked there and must come through here instead.
router.post('/:id/cancel', auth(AuthUser.ADMIN, AuthUser.DOCTOR, AuthUser.PATIENT), AppointmentController.cancelAppointment);
router.post('/:id/reschedule', auth(AuthUser.ADMIN, AuthUser.DOCTOR, AuthUser.PATIENT), AppointmentController.rescheduleAppointment);
//doctor side
router.patch('/doctor/update-appointment',auth(AuthUser.DOCTOR), AppointmentController.updateAppointmentByDoctor);


export const AppointmentRouter = router;