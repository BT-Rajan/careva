import httpStatus from "http-status";
import ApiError from "../../../errors/apiError";
import prisma from "../../../shared/prisma";
import { Prescription, AppointmentStatus } from "@prisma/client";
import { assertValidAppointmentTransition } from "../appointment/appointment-state-machine";

const createPrescription = async (user: any, paylaod: any): Promise<{message: string}> => {
    const { medicine, ...others } = paylaod;
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) { throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!') }

    const isAppointment = await prisma.appointments.findUnique({
        where: {
            id: paylaod.appointmentId
        }
    })
    if (!isAppointment) { throw new ApiError(httpStatus.NOT_FOUND, 'Appopintment is not found !!') }
    // Pass 4: previously verified the caller was *a* doctor but never that the target
    // appointment belonged to *that* doctor — any doctor could write a prescription
    // against another doctor's patient/appointment.
    if (isAppointment.doctorId !== isDoctor.id) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to prescribe for this appointment !!');
    }

    // Pass 12 BUG FIX (critical, live-breaking): this previously took a raw `status`
    // string straight from the client (Treatment.jsx's dropdown, which used a stale
    // constant — 'confirmed', 'InProgress', 'archived', etc. — none of which have ever
    // been valid values, and definitely aren't valid AppointmentStatus enum members
    // since Pass 8) and wrote it directly via Prisma, completely bypassing
    // assertValidAppointmentTransition. Since Pass 8 turned `status` into a real enum,
    // every one of the dropdown's options would fail the update with a Prisma validation
    // error — meaning doctors could not successfully create a prescription at all through
    // this form. Fixed at the root: creating a prescription always means treatment was
    // given, which always means the appointment is now COMPLETED — there was never a
    // real reason for this to be a free-form field the client controls. See
    // Doctor/Treatment/Treatment.jsx for the matching frontend fix (the status picker is
    // removed, not just corrected, since the outcome is no longer ambiguous).
    const { patientType, ...rest } = others;
    assertValidAppointmentTransition(isAppointment.status as AppointmentStatus, 'COMPLETED', 'doctor');

    await prisma.$transaction(async (tx) => {
        await tx.appointments.update({
            where: {
                id: isAppointment.id
            },
            data: {
                isFollowUp: paylaod.followUpDate ? true : false,
                status: 'COMPLETED',
                statusChangedAt: new Date(),
                statusChangedBy: userId,
                patientType: patientType || undefined,
                prescriptionStatus: "issued"
            }
        })
        await tx.auditLog.create({
            data: {
                actorId: userId,
                actorRole: 'doctor',
                action: 'appointment.status_changed',
                entityType: 'Appointments',
                entityId: isAppointment.id,
                metadata: { from: isAppointment.status, to: 'COMPLETED', reason: 'Prescription created' },
            }
        });

        const prescription = await tx.prescription.create({
            data: {
                ...rest,
                doctorId: isDoctor.id,
                patientId: isAppointment.patientId,
                medicines: undefined
            }
        });
        // Pass 12 — Medical-record audit trail. Prescription create/update/delete had no
        // audit trail at all before this pass — a clinical record with real legal weight
        // was exactly as unaudited as any other CRUD row.
        await tx.auditLog.create({
            data: {
                actorId: userId,
                actorRole: 'doctor',
                action: 'prescription.created',
                entityType: 'Prescription',
                entityId: prescription.id,
                metadata: { appointmentId: isAppointment.id, patientId: isAppointment.patientId },
            }
        });

        const medicinePromise = medicine.map((medicine: any) =>
            tx.medicine.create({
                data: {
                    dosage: medicine.dosage,
                    duration: medicine.duration,
                    frequency: medicine.frequency,
                    medicine: medicine.medicine,
                    prescriptionId: prescription.id
                }
            })
        )
        await Promise.all(medicinePromise)
    })
    return {
        message: "Successfully Prescription Created"
    }
}
// Update Prescription and Appointment table 
const updatePrescriptionAndAppointment = async (user: any, paylaod: any): Promise<{message: string}> => {
    const {status, patientType,followUpdate,prescriptionId, ...others} = paylaod;
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) { throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!') }

    const isPrescribed = await prisma.prescription.findUnique({
        where: {
            id: prescriptionId
        }
    })
    if (!isPrescribed) { throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!') }
    // Pass 4: previously no ownership check — any doctor could update any other
    // doctor's prescription (and its linked appointment) by supplying its id.
    if (isPrescribed.doctorId !== isDoctor.id) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this prescription !!');
    }

    await prisma.$transaction(async (tx) => {

        // Pass 12 BUG FIX: previously wrote a raw `status` field straight from the
        // client here too (same broken source as createPrescription's bug — see that
        // function's comment). By the time a prescription exists to edit, its
        // appointment is already COMPLETED (a terminal state — Pass 8's state machine
        // has zero legal outgoing transitions from it), so this update never needs to
        // touch status at all; `status` is destructured off `paylaod` above purely to
        // keep it out of `others`/`rest` and is otherwise ignored.
        await tx.appointments.update({
            where: {
                id: isPrescribed.appointmentId
            },
            data: {
                isFollowUp: followUpdate ? true : false,
                patientType: patientType,
            }
        })
        
        await tx.prescription.update({
            where: {
                id: prescriptionId
            },
            data: {
                ...others,
            }
        });
        // Pass 12 — Medical-record audit trail.
        await tx.auditLog.create({
            data: {
                actorId: userId,
                actorRole: 'doctor',
                action: 'prescription.updated',
                entityType: 'Prescription',
                entityId: prescriptionId,
                metadata: { appointmentId: isPrescribed.appointmentId, fields: Object.keys(others) },
            }
        });

    })
    return {
        message: "Successfully Prescription Updated"
    }
}

const getAllPrescriptions = async (): Promise<Prescription[] | null> => {
    const result = await prisma.prescription.findMany({
        include: {
            appointment: {
                select: {
                    trackingId: true
                }
            }
        }
    });
    return result;
}

const getPrescriptionById = async (reqUser: any, id: string): Promise<Prescription | null> => {
    const result = await prisma.prescription.findUnique({
        where: {
            id: id
        },
        include: {
            medicines: true,
            appointment: {
                select: {
                    scheduleDate: true,
                    scheduleTime: true,
                    status: true,
                    trackingId: true,
                }
            },
            doctor: {
                select: {
                    firstName: true,
                    lastName: true,
                    designation: true,
                    email: true,
                    college: true,
                    address: true,
                    country: true,
                    state: true,
                    specialization: true
                }
            },
            patient: {
                select: {
                    firstName: true,
                    lastName: true,
                    gender: true,
                    dateOfBirth: true,
                    email: true,
                    bloodGroup: true,
                    address: true,
                    img: true,
                    city: true,
                }
            }
        }
    });
    // Pass 4: previously no ownership check at all — any authenticated user of any role
    // could fetch any prescription by id. Now: the prescribing doctor, the patient it
    // belongs to, or an admin.
    if (result) {
        const isAdmin = reqUser?.role === 'admin';
        const isOwner = result.doctorId === reqUser?.userId || result.patientId === reqUser?.userId;
        if (!isAdmin && !isOwner) {
            throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this prescription !!');
        }
    }
    return result;
}

const getPatientPrescriptionById = async (user: any): Promise<Prescription[] | null> => {
    const { userId } = user;
    const isPatient = await prisma.patient.findUnique({
        where: {
            id: userId
        }
    })
    if (!isPatient) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Patient Account is not found !!')
    }
    const result = await prisma.prescription.findMany({
        where: {
            patientId: userId
        },
        include: {
            doctor: {
                select: {
                    firstName: true,
                    lastName: true,
                    designation: true
                }
            },
            appointment: {
                select: {
                    scheduleDate: true,
                    scheduleTime: true,
                    status: true,
                    trackingId: true
                }
            }
        }
    })
    return result;
}

const getDoctorPrescriptionById = async (user: any): Promise<Prescription[] | null> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    const result = await prisma.prescription.findMany({
        where: {
            doctorId: userId,
        },
        include: {
            medicines: true,
            patient: true
        }
    })
    return result;
}

const deletePrescription = async (reqUser: any, id: string): Promise<any> => {
    // Pass 4: previously no ownership check at all — any doctor (the route also allows
    // admin) could delete any other doctor's prescription record.
    const existing = await prisma.prescription.findUnique({ where: { id } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    if (!isAdmin && existing.doctorId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to delete this prescription !!');
    }
    const result = await prisma.prescription.delete({
        where: {
            id: id
        }
    });
    return result;
}

// Pass 4: fields no caller may set through this endpoint via mass-assignment — excludes
// id/doctorId/patientId/appointmentId/timestamps, none of which should ever change via a
// content edit.
const PRESCRIPTION_EDITABLE_FIELDS = ['followUpdate', 'instruction', 'isFullfilled', 'isArchived', 'daignosis', 'disease', 'test'] as const;

const updatePrescription = async (reqUser: any, id: string, payload: Partial<Prescription>): Promise<Prescription> => {
    const existing = await prisma.prescription.findUnique({ where: { id } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!');
    }
    // Pass 4: previously no ownership check, and the full request body was passed
    // straight to Prisma (mass-assignment).
    const isAdmin = reqUser?.role === 'admin';
    if (!isAdmin && existing.doctorId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this prescription !!');
    }
    const data: Partial<Prescription> = {};
    for (const field of PRESCRIPTION_EDITABLE_FIELDS) {
        if (field in payload) {
            (data as any)[field] = (payload as any)[field];
        }
    }
    const result = await prisma.prescription.update({
        data,
        where: {
            id: id
        }
    })
    return result;
}

export const PrescriptionService = {
    createPrescription,
    getDoctorPrescriptionById,
    updatePrescription,
    getPatientPrescriptionById,
    deletePrescription,
    getPrescriptionById,
    getAllPrescriptions,
    updatePrescriptionAndAppointment
}