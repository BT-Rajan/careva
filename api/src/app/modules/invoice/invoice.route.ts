import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { InvoiceController } from './invoice.controller';

const router = express.Router();

// Pass 14 — Invoice & Financial Records. Order matters: the specific /doctor and
// /patient list routes must be registered before the generic /:id route, or Express
// would try to match "doctor"/"patient" as an :id value.
router.get('/doctor', auth(AuthUser.DOCTOR), InvoiceController.getDoctorInvoices);
router.get('/patient', auth(AuthUser.PATIENT), InvoiceController.getPatientInvoices);
router.get('/appointment/:appointmentId', auth(AuthUser.PATIENT, AuthUser.DOCTOR, AuthUser.ADMIN), InvoiceController.getInvoiceByAppointmentId);
router.get('/:id', auth(AuthUser.PATIENT, AuthUser.DOCTOR, AuthUser.ADMIN), InvoiceController.getInvoiceById);
router.patch('/:id/void', auth(AuthUser.ADMIN), InvoiceController.voidInvoice);
router.post('/:id/correct', auth(AuthUser.ADMIN), InvoiceController.correctInvoice);

export const InvoiceRouter = router;
