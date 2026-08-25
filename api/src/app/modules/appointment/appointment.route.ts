import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { AppointmentController } from './appointment.controller';

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

router.post('/tracking', AppointmentController.getAppointmentByTrackingId);
router.post('/create', AppointmentController.createAppointment);
router.post('/create-un-authenticate', AppointmentController.createAppointmentByUnAuthenticateUser);

// Pass 4: intentionally left public — BookingSuccess.jsx (guest, unauthenticated,
// post-booking confirmation) and BookingInvoice.jsx depend on this being reachable
// without login. Locking it down properly (e.g. requiring the opaque trackingId instead
// of the raw database id) is Pass 15's job (Tracking & Public Access), not this pass's —
// see docs/passes/04-authorization-rbac.md §"deferred".
router.get('/:id', AppointmentController.getAppointment);

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