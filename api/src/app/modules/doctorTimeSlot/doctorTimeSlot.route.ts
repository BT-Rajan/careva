import express from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { doctorTimeSlotController } from './doctorTimeSlot.controller';

const router = express.Router();

router.get('/my-slot', auth(AuthUser.DOCTOR), doctorTimeSlotController.getMyTimeSlot);
// Pass 11 — Doctor Schedule Engine: blocked dates / holidays. Registered before /:id so
// "blocked-dates" is never captured as a time-slot id.
router.get('/blocked-dates', auth(AuthUser.DOCTOR), doctorTimeSlotController.getMyBlockedDates);
router.post('/blocked-dates', auth(AuthUser.DOCTOR), doctorTimeSlotController.createBlockedDate);
router.delete('/blocked-dates/:id', auth(AuthUser.DOCTOR), doctorTimeSlotController.deleteBlockedDate);
router.get('/:id', auth(AuthUser.DOCTOR), doctorTimeSlotController.getTimeSlot);
router.get('/appointment-time/:id', doctorTimeSlotController.getAppointmentTimeOfEachDoctor);
router.post('/create', auth(AuthUser.DOCTOR), doctorTimeSlotController.createTimeSlot);
router.get('/', doctorTimeSlotController.getAllTimeSlot);
router.patch('/', auth(AuthUser.DOCTOR), doctorTimeSlotController.updateTimeSlot);
router.delete('/:id', auth(AuthUser.DOCTOR), doctorTimeSlotController.deleteTimeSlot);

export const DoctorTimeSlotRouter = router;