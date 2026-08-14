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
router.get('/patient/invoices',auth(AuthUser.PATIENT), AppointmentController.getPatientPaymentInfo);
router.get('/doctor/invoices',auth(AuthUser.DOCTOR), AppointmentController.getDoctorInvoices);

router.get('/doctor/appointments',auth(AuthUser.DOCTOR), AppointmentController.getDoctorAppointmentsById);
router.get('/doctor/patients',auth(AuthUser.DOCTOR), AppointmentController.getDoctorPatients);

router.get('/patient-payment-info/:id',auth(AuthUser.PATIENT, AuthUser.DOCTOR), AppointmentController.getPaymentInfoViaAppintmentId);

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
//doctor side
router.patch('/doctor/update-appointment',auth(AuthUser.DOCTOR), AppointmentController.updateAppointmentByDoctor);


export const AppointmentRouter = router;