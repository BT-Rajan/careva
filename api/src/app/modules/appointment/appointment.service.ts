import { Appointments, Patient, Payment, paymentStatus, Prisma } from "@prisma/client";
import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import moment from 'moment';
import { EmailtTransporter } from "../../../helpers/emailTransporter";
import * as path from 'path';
import config from "../../../config";

// Pass 5 — Appointment & Slot Engine.
//
// Before this pass, NOTHING in the database or application code checked whether a slot
// had capacity before creating an appointment (Gap G9, docs/passes/01-domain-state-model.md
// §4.7/§5). `createAppointment` and `createAppointmentByUnAuthenticateUser` just inserted
// a row with whatever `scheduleDate`/`scheduleTime` strings the client sent — no validation
// that the time was even part of the doctor's configured hours, and no cap on how many
// appointments could pile up on the exact same doctor+date+time. This function is the
// fix, called from inside the SAME transaction as the appointment insert, under
// Serializable isolation (see the two callers below) so that two concurrent booking
// requests for the last remaining seat in a slot cannot both succeed — Postgres will
// abort one of them with a serialization failure, which the caller retries/reports.
//
// Capacity comes from `DoctorTimeSlot.maximumPatient`, set per weekday
// (docs/passes/01-domain-state-model.md §4.7 flagged this as the central gap this pass
// exists to close). Cancelled appointments ('cancel' — see Pass 1 §3.2 on the current
// literal status strings; this intentionally does not touch that representation, which is
// Pass 8's job) don't count against capacity, since cancelling frees the seat.
const assertSlotAvailable = async (
    tx: Prisma.TransactionClient,
    doctorId: string,
    scheduleDate: string | undefined,
    scheduleTime: string | undefined
): Promise<void> => {
    if (!scheduleDate || !scheduleTime) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'scheduleDate and scheduleTime are required !!');
    }

    const weekday = moment(scheduleDate).format('dddd').toLowerCase();
    const doctorTimeSlot = await tx.doctorTimeSlot.findFirst({
        where: { doctorId, day: weekday as any },
        include: { timeSlot: true }
    });
    if (!doctorTimeSlot) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Doctor is not available on the selected day !!");
    }

    // Defense in depth: previously nothing checked that scheduleTime actually fell within
    // one of the doctor's configured ranges — a client could submit any arbitrary time
    // string. Uses the same 30-minute grid getAppointmentTimeOfEachDoctor generates for
    // display, so a time is valid if it falls inside any configured [startTime, endTime).
    const requested = moment(scheduleTime, ['hh:mm a', 'HH:mm']);
    const isWithinConfiguredRange = doctorTimeSlot.timeSlot.some((range) => {
        const start = moment(range.startTime, ['hh:mm a', 'HH:mm']);
        const end = moment(range.endTime, ['hh:mm a', 'HH:mm']);
        return requested.isSameOrAfter(start) && requested.isBefore(end);
    });
    if (!isWithinConfiguredRange) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Selected time is outside the doctor's available hours !!");
    }

    const maximumPatient = doctorTimeSlot.maximumPatient ?? 1;
    const existingCount = await tx.appointments.count({
        where: {
            doctorId,
            scheduleDate,
            scheduleTime,
            status: { not: 'cancel' }
        }
    });
    if (existingCount >= maximumPatient) {
        throw new ApiError(httpStatus.CONFLICT, 'This time slot is fully booked. Please choose another time !!');
    }
}

// Postgres error code 40001 ("serialization_failure") surfaces through Prisma as P2034.
// This is the EXPECTED, correct outcome of two concurrent requests racing for the same
// slot under Serializable isolation — not a bug. One retry is standard practice for
// serializable transactions (most conflicts are transient); if it still fails on retry,
// that's reported as a real "slot no longer available" rather than a generic 500.
const runBookingTransaction = async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
    const attempt = () => prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 15000 });
    try {
        return await attempt();
    } catch (error: any) {
        if (error?.code === 'P2034') {
            try {
                return await attempt();
            } catch (retryError: any) {
                if (retryError?.code === 'P2034') {
                    throw new ApiError(httpStatus.CONFLICT, 'This time slot was just booked by someone else. Please choose another time !!');
                }
                throw retryError;
            }
        }
        throw error;
    }
}

const createAppointment = async (payload: any): Promise<Appointments | null | any> => {

    const { patientInfo, payment } = payload;
    if(patientInfo.patientId){
        const isUserExist = await prisma.patient.findUnique({
            where: {
                id: patientInfo.patientId
            }
        })
        if (!isUserExist) {
            patientInfo['patientId'] = null
        }
    }

    const isDoctorExist = await prisma.doctor.findUnique({
        where: {
            id: patientInfo.doctorId
        }
    });

    if (!isDoctorExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    patientInfo['paymentStatus'] = paymentStatus.paid;
  
    const result = await runBookingTransaction(async (tx) => {
        // Pass 5: the single most important check in the whole booking flow — must run
        // first, inside the same transaction as the insert. See assertSlotAvailable above.
        await assertSlotAvailable(tx, patientInfo.doctorId, patientInfo.scheduleDate, patientInfo.scheduleTime);

        const previousAppointment = await tx.appointments.findFirst({
            orderBy: { createdAt: 'desc' },
            take: 1
        });
        const appointmentLastNumber = (previousAppointment?.trackingId ?? '').slice(-3);
        const lastDigit = (Number(appointmentLastNumber) + 1 || 0).toString().padStart(3, '0');

        // Trcking Id To be ==> First 3 Letter Of User  + current year + current month + current day + unique number (Matched Previous Appointment).
        const first3DigitName = patientInfo?.firstName?.slice(0, 3).toUpperCase();
        const year = moment().year();
        const month = (moment().month() + 1).toString().padStart(2, '0');
        const day = (moment().dayOfYear()).toString().padStart(2, '0');
        const trackingId = first3DigitName + year + month + day + lastDigit || '001';
        patientInfo['trackingId'] = trackingId;

        const appointment = await tx.appointments.create({
            data: patientInfo,
            include: {
                doctor: true,
                patient: true
            }
        });
        const { paymentMethod, paymentType } = payment;
        const docFee = Number(isDoctorExist.price);
        const vat = (15 / 100) * (docFee + 10)
        if (appointment.id) {
            await tx.payment.create({
                data: {
                    appointmentId: appointment.id,
                    bookingFee: 10,
                    paymentMethod: paymentMethod,
                    paymentType: paymentType,
                    vat: vat,
                    DoctorFee: docFee,
                    totalAmount: (vat + docFee),
                }
            })
        }
        const pathName = path.join(__dirname, '../../../../template/appointment.html')
        const appointmentObj = {
            created: moment(appointment.createdAt).format('LL'),
            trackingId: appointment.trackingId,
            patientType: appointment.patientType,
            status: appointment.status,
            paymentStatus: appointment.paymentStatus,
            prescriptionStatus: appointment.prescriptionStatus,
            scheduleDate:moment(appointment.scheduleDate).format('LL'),
            scheduleTime:appointment.scheduleTime,
            doctorImg: appointment?.doctor?.img,
            doctorFirstName: appointment?.doctor?.firstName,
            doctorLastName: appointment?.doctor?.lastName,
            specialization:appointment?.doctor?.specialization,
            designation:appointment?.doctor?.designation,
            college:appointment?.doctor?.college,
            patientImg:appointment?.patient?.img,
            patientfirstName:appointment?.patient?.firstName,
            patientLastName:appointment?.patient?.lastName,
            dateOfBirth: moment().diff(moment(appointment?.patient?.dateOfBirth), 'years'),
            bloodGroup:appointment?.patient?.bloodGroup,
            city:appointment?.patient?.city,
            state:appointment?.patient?.state,
            country:appointment?.patient?.country
        }
        const replacementObj = appointmentObj;
        const subject = `Appointment Confirm With Dr ${appointment?.doctor?.firstName + ' ' + appointment?.doctor?.lastName} at ${appointment.scheduleDate} + ' ' + ${appointment.scheduleTime}`
        const toMail = `${appointment.email + ',' + appointment.doctor?.email}`;
        EmailtTransporter({ pathName, replacementObj, toMail, subject })
        return appointment;
    });
    return result;
}

const createAppointmentByUnAuthenticateUser = async (payload: any): Promise<Appointments | null> => {
    const { patientInfo, payment } = payload;
    if(patientInfo.patientId){
        const isUserExist = await prisma.patient.findUnique({
            where: {
                id: patientInfo.patientId
            }
        })
        if (!isUserExist) {
            patientInfo['patientId'] = null
        }
    }

    const result = await runBookingTransaction(async (tx) => {
        const previousAppointment = await tx.appointments.findFirst({
            orderBy: { createdAt: 'desc' },
            take: 1
        });

        const appointmentLastNumber = (previousAppointment?.trackingId ?? '').slice(-3);
        const lastDigit = (Number(appointmentLastNumber) + 1).toString().padStart(3, '0')
        // Trcking Id To be ==> UNU - 'Un Authenticate User  + current year + current month + current day + unique number (Matched Previous Appointment).
        const year = moment().year();
        const month = (moment().month() + 1).toString().padStart(2, '0');
        const day = (moment().dayOfYear()).toString().padStart(2, '0');
        const trackingId = 'UNU' + year + month + day + lastDigit || '0001';
        patientInfo['trackingId'] = trackingId;
        const doctorIdForUnauth = patientInfo.doctorId || config.defaultAdminDoctor;
        patientInfo['doctorId'] = doctorIdForUnauth;

        const doctorForFee = await tx.doctor.findUnique({ where: { id: doctorIdForUnauth } });
        if (!doctorForFee) {
            throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
        }
        const docFee = doctorForFee.price != null ? Number(doctorForFee.price) : 60;

        // Pass 5: same check as the authenticated path — must run before the insert,
        // inside this transaction. See assertSlotAvailable above.
        await assertSlotAvailable(tx, doctorIdForUnauth, patientInfo.scheduleDate, patientInfo.scheduleTime);

        const appointment = await tx.appointments.create({
            data: patientInfo,
        });
        const { paymentMethod, paymentType } = payment;
        const vat = (15 / 100) * (docFee + 10);
        if (appointment.id) {
            await tx.payment.create({
                data: {
                    appointmentId: appointment.id,
                    bookingFee: 10,
                    paymentMethod: paymentMethod,
                    paymentType: paymentType,
                    vat: vat,
                    DoctorFee: docFee,
                    totalAmount: (vat + docFee),
                }
            })
        }

        const appointmentObj = {
            created: moment(appointment.createdAt).format('LL'),
            trackingId: appointment.trackingId,
            patientType: appointment.patientType,
            status: appointment.status,
            paymentStatus: appointment.paymentStatus,
            prescriptionStatus: appointment.prescriptionStatus,
            scheduleDate:moment(appointment.scheduleDate).format('LL'),
            scheduleTime:appointment.scheduleTime,
        }
        const pathName = path.join(__dirname, '../../../../template/meeting.html')
        const replacementObj = appointmentObj;
        const subject = `Appointment Confirm at ${appointment.scheduleDate} ${appointment.scheduleTime}`

        const toMail = `${appointment.email}`;
        EmailtTransporter({ pathName, replacementObj, toMail, subject })
        return appointment;
    })

    return result;
}

const getAllAppointments = async (): Promise<Appointments[] | null> => {
    const result = await prisma.appointments.findMany();
    return result;
}

const getAppointment = async (id: string): Promise<Appointments | null> => {
    const result = await prisma.appointments.findUnique({
        where: {
            id: id
        },
        include: {
            doctor: true,
            patient: true
        }
    });
    return result;
}

const getAppointmentByTrackingId = async (data: any): Promise<Appointments | null> => {
    const { id } = data;

    const result = await prisma.appointments.findUnique({
        where: {
            trackingId: id
        },
        include: {
            doctor: {
                select: {
                    firstName: true,
                    lastName: true,
                    designation: true,
                    college: true,
                    degree: true,
                    img: true
                },
            },
            patient: {
                select: {
                    firstName: true,
                    lastName: true,
                    address: true,
                    city: true,
                    country: true,
                    state: true,
                    img: true
                }
            }
        }
    });
    return result;
}

const getPatientAppointmentById = async (user: any): Promise<Appointments[] | null> => {
    const { userId } = user;
    const isPatient = await prisma.patient.findUnique({
        where: {
            id: userId
        }
    })
    if (!isPatient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient Account is not found !!')
    }
    const result = await prisma.appointments.findMany({
        where: {
            patientId: userId
        },
        include: {
            doctor: true
        }
    })
    return result;
}

const getPaymentInfoViaAppintmentId = async (reqUser: any, id: string): Promise<any> => {
    // Pass 4: previously no ownership check — any authenticated patient or doctor could
    // view any OTHER appointment's payment/financial info by supplying an arbitrary id.
    const appointment = await prisma.appointments.findUnique({ where: { id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this payment info !!');
    }
    const result = await prisma.payment.findFirst({
        where: {
            appointmentId: id
        },
        include: {
            appointment: {
                include: {
                    patient: {
                        select: {
                            firstName: true,
                            lastName: true,
                            address: true,
                            country: true,
                            city: true
                        }
                    },
                    doctor: {
                        select: {
                            firstName: true,
                            lastName: true,
                            address: true,
                            country: true,
                            city: true
                        }
                    }
                }
            }
        }
    });
    return result;
}

const getPatientPaymentInfo = async (user: any): Promise<Payment[]> => {
    const { userId } = user;
    const isUserExist = await prisma.patient.findUnique({
        where: { id: userId }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient Account is not found !!')
    }
    const result = await prisma.payment.findMany({
        where: { appointment: { patientId: isUserExist.id } },
        include: {
            appointment: {
                include: {
                    doctor: {
                        select: {
                            firstName: true,
                            lastName: true,
                            designation: true
                        }
                    }
                }
            }
        }
    });
    return result;
}
const getDoctorInvoices = async (user: any): Promise<Payment[] | null> => {
    const { userId } = user;
    const isUserExist = await prisma.doctor.findUnique({
        where: { id: userId }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    const result = await prisma.payment.findMany({
        where: { appointment: { doctorId: isUserExist.id } },
        include: {
            appointment: {
                include: {
                    patient: {
                        select: {
                            firstName: true,
                            lastName: true
                        }
                    }
                }
            }
        }
    });
    return result;
}

const deleteAppointment = async (id: string): Promise<any> => {
    const result = await prisma.appointments.delete({
        where: {
            id: id
        }
    });
    return result;
}

const updateAppointment = async (reqUser: any, id: string, payload: Partial<Appointments>): Promise<Appointments> => {
    // Pass 4: previously no ownership check, and the full request body was passed
    // straight to Prisma (mass-assignment) — any authenticated patient/doctor could PATCH
    // ANY appointment with arbitrary fields (paymentStatus, doctorId, etc.), not just
    // their own. Confirmed via the frontend that every real caller (doctor Accept/Cancel
    // buttons, admin panel) only ever sends `{ status }`, so restricting to that field
    // doesn't break anything live. Full transition-legality rules (which status can
    // follow which) are Pass 8's job — this only controls WHO can act and WHAT field.
    const appointment = await prisma.appointments.findUnique({ where: { id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    const isOwner = appointment.patientId === reqUser?.userId || appointment.doctorId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this appointment !!');
    }
    const result = await prisma.appointments.update({
        data: { status: payload.status },
        where: {
            id: id
        }
    })
    return result;
}

//doctor Side
const getDoctorAppointmentsById = async (user: any, filter: any): Promise<Appointments[] | null> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) { throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!') }

    let andCondition: any = { doctorId: userId };

    if (filter.sortBy == 'today') {
        const today = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const tomorrow = moment(today).add(1, 'days').format('YYYY-MM-DD HH:mm:ss');

        andCondition.scheduleDate = {
            gte: today,
            lt: tomorrow
        }
    }
    if (filter.sortBy == 'upcoming') {
        const upcomingDate = moment().startOf('day').add(1, 'days').format('YYYY-MM-DD HH:mm:ss')
        andCondition.scheduleDate = {
            gte: upcomingDate
        }
    }
    const whereConditions = andCondition ? andCondition : {}

    const result = await prisma.appointments.findMany({
        where: whereConditions,
        include: {
            patient: true,
            prescription: {
                select: {
                    id: true
                }
            }
        }
    });
    return result;
}

const getDoctorPatients = async (user: any): Promise<Patient[]> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }

    const patients = await prisma.appointments.findMany({
        where: {
            doctorId: userId
        },
        distinct: ['patientId']
    });

    //extract patients from the appointments table
    const patientIds = patients.map(appointment => appointment.patientId);
    const patientList = await prisma.patient.findMany({
        where: {
            id: {
                // @ts-ignore
                in: patientIds
            }
        }
    })
    return patientList;
}

const updateAppointmentByDoctor = async (user: any, payload: Partial<Appointments> & { id?: string }): Promise<Appointments | null> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    if (!payload.id) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Appointment id is required !!')
    }
    // Pass 4: previously verified the caller was *a* doctor but never that the target
    // appointment belonged to *that* doctor — any doctor could update any other doctor's
    // appointments. Also restricted the update to a safe field set instead of accepting
    // the full Partial<Appointments> body (mass-assignment).
    const appointment = await prisma.appointments.findUnique({ where: { id: payload.id } });
    if (!appointment) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Appointment is not found !!');
    }
    if (appointment.doctorId !== userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this appointment !!');
    }
    const { status, prescriptionStatus, description, reasonForVisit } = payload;
    const result = await prisma.appointments.update({
        where: {
            id: payload.id
        },
        data: { status, prescriptionStatus, description, reasonForVisit }
    })
    return result;
}

export const AppointmentService = {
    createAppointment,
    getAllAppointments,
    getAppointment,
    deleteAppointment,
    updateAppointment,
    getPatientAppointmentById,
    getDoctorAppointmentsById,
    updateAppointmentByDoctor,
    getDoctorPatients,
    getPaymentInfoViaAppintmentId,
    getPatientPaymentInfo,
    getDoctorInvoices,
    createAppointmentByUnAuthenticateUser,
    getAppointmentByTrackingId
}