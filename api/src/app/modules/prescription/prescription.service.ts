import httpStatus from "http-status";
import ApiError from "../../../errors/apiError";
import prisma from "../../../shared/prisma";
import { Prescription, AppointmentStatus, PrescriptionStatus } from "@prisma/client";
import { assertValidAppointmentTransition } from "../appointment/appointment-state-machine";
import { assertValidPrescriptionTransition, PrescriptionActorRole } from "./prescription-lifecycle";

// Pass 13: shared by every mutation below that touches a prescription's clinical
// content or lifecycle — a soft-deleted row is not a valid target for anything.
const ACTIVE_PRESCRIPTION_FILTER = { deletedAt: null } as const;

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
//
// Pass 13: this used to mutate the prescription's clinical content (`daignosis`,
// `disease`, `test`, `instruction`, `followUpdate`) in place via `tx.prescription.update`
// — exactly the thing the target lifecycle (docs/passes/01-domain-state-model.md §4.4)
// says a clinical record must never do once issued. This is the endpoint
// TreatmentEdit.jsx already calls to "edit" a prescription, so rather than add a
// separate, unused correction endpoint the frontend would need new wiring to reach,
// this function's clinical-content half now performs a real correction: the existing
// row transitions ISSUED/FULFILLED → CORRECTED and stays intact, and a new row is
// created (status ISSUED, supersedesId → the original) carrying the edited fields.
// Appointment-side fields (isFollowUp, patientType) are follow-up/scheduling metadata,
// not part of the versioned medical record, and continue to update in place as before.
const updatePrescriptionAndAppointment = async (user: any, paylaod: any): Promise<{message: string, prescriptionId: string}> => {
    const {status, patientType, followUpdate, prescriptionId, ...others} = paylaod;
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) { throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!') }

    const isPrescribed = await prisma.prescription.findFirst({
        where: {
            id: prescriptionId,
            ...ACTIVE_PRESCRIPTION_FILTER
        }
    })
    if (!isPrescribed) { throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!') }
    // Pass 4: previously no ownership check — any doctor could update any other
    // doctor's prescription (and its linked appointment) by supplying its id.
    if (isPrescribed.doctorId !== isDoctor.id) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this prescription !!');
    }
    // Pass 13: same shape/actor check as every other state transition in the app —
    // read the current status fresh from the database, never trust a client-asserted
    // "from". A CORRECTED or ARCHIVED prescription has no legal outgoing transition, so
    // attempting to "edit" one now fails loudly here instead of silently mutating a
    // record that's supposed to be closed.
    assertValidPrescriptionTransition(isPrescribed.status, 'CORRECTED', 'doctor');

    const newPrescriptionId = await prisma.$transaction(async (tx) => {
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
            where: { id: prescriptionId },
            data: { status: 'CORRECTED' }
        });

        const corrected = await tx.prescription.create({
            data: {
                doctorId: isPrescribed.doctorId,
                patientId: isPrescribed.patientId,
                appointmentId: isPrescribed.appointmentId,
                disease: isPrescribed.disease,
                daignosis: isPrescribed.daignosis,
                test: isPrescribed.test,
                instruction: isPrescribed.instruction,
                followUpdate: followUpdate ?? isPrescribed.followUpdate,
                // Only fields the client actually sent for editing (disease/daignosis/
                // test/instruction, whichever it included) override the copied-forward
                // defaults above; anything not sent stays as it was on the original.
                ...others,
                status: 'ISSUED',
                supersedesId: isPrescribed.id,
            }
        });

        // Carry the medicine list forward onto the new version — the original's
        // medicines stay attached to the original row (an intact audit record), the
        // corrected version gets its own copy that future edits will version again.
        const medicines = await tx.medicine.findMany({ where: { prescriptionId: isPrescribed.id } });
        await Promise.all(medicines.map((m) => tx.medicine.create({
            data: {
                medicine: m.medicine,
                dosage: m.dosage,
                frequency: m.frequency,
                duration: m.duration,
                prescriptionId: corrected.id,
            }
        })));

        // Pass 12 — Medical-record audit trail, extended in Pass 13 to log the
        // correction as what it actually is (a new version), not an in-place update.
        await tx.auditLog.create({
            data: {
                actorId: userId,
                actorRole: 'doctor',
                action: 'prescription.corrected',
                entityType: 'Prescription',
                entityId: isPrescribed.id,
                metadata: { appointmentId: isPrescribed.appointmentId, supersededBy: corrected.id },
            }
        });
        await tx.auditLog.create({
            data: {
                actorId: userId,
                actorRole: 'doctor',
                action: 'prescription.created',
                entityType: 'Prescription',
                entityId: corrected.id,
                metadata: { appointmentId: isPrescribed.appointmentId, reason: 'correction', supersedes: isPrescribed.id },
            }
        });

        return corrected.id;
    })
    return {
        message: "Successfully Prescription Updated",
        prescriptionId: newPrescriptionId
    }
}

// Pass 13: patient marks their own prescription as fulfilled (obtained from the
// pharmacy); a doctor or admin can also record it (e.g. the patient reports it at a
// follow-up visit) — see prescription-lifecycle.ts for why the patient is the primary
// actor on this specific edge.
const markPrescriptionFulfilled = async (reqUser: any, id: string): Promise<Prescription> => {
    const existing = await prisma.prescription.findFirst({ where: { id, ...ACTIVE_PRESCRIPTION_FILTER } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!');
    }
    const role = reqUser?.role as PrescriptionActorRole;
    const isAdmin = role === 'admin';
    const isOwner = existing.doctorId === reqUser?.userId || existing.patientId === reqUser?.userId;
    if (!isAdmin && !isOwner) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this prescription !!');
    }
    assertValidPrescriptionTransition(existing.status, 'FULFILLED', role);
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.prescription.update({ where: { id }, data: { status: 'FULFILLED' } });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: role,
                action: 'prescription.status_changed',
                entityType: 'Prescription',
                entityId: id,
                metadata: { from: existing.status, to: 'FULFILLED' },
            }
        });
        return updated;
    });
    return result;
}

// Pass 13: hides a prescription from active listings without erasing it — same
// visibility-only intent as the target model's ARCHIVED state. Doctor (own record) or
// admin only; a patient marking their own prescription "not relevant anymore" isn't a
// need anyone asked for, unlike fulfillment which only the patient can truly attest to.
const archivePrescription = async (reqUser: any, id: string): Promise<Prescription> => {
    const existing = await prisma.prescription.findFirst({ where: { id, ...ACTIVE_PRESCRIPTION_FILTER } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!');
    }
    const role = reqUser?.role as PrescriptionActorRole;
    const isAdmin = role === 'admin';
    if (!isAdmin && existing.doctorId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this prescription !!');
    }
    assertValidPrescriptionTransition(existing.status, 'ARCHIVED', role);
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.prescription.update({ where: { id }, data: { status: 'ARCHIVED' } });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: role,
                action: 'prescription.status_changed',
                entityType: 'Prescription',
                entityId: id,
                metadata: { from: existing.status, to: 'ARCHIVED' },
            }
        });
        return updated;
    });
    return result;
}

const getAllPrescriptions = async (): Promise<Prescription[] | null> => {
    // Pass 13: a soft-deleted prescription is deactivated, not gone — dropped from
    // every listing, same convention as Pass 12's Patient soft-delete.
    const result = await prisma.prescription.findMany({
        where: { ...ACTIVE_PRESCRIPTION_FILTER },
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
    // Pass 13: intentionally NOT filtered by deletedAt/status here. Unlike the list
    // endpoints (where a deactivated/corrected record should disappear from what a
    // doctor or patient browses), a direct-by-id fetch is how the app displays a
    // specific historical version — e.g. following a supersededBy/supersedes link, or a
    // patient revisiting a link to an old prescription. Hiding it here would break
    // exactly the record continuity soft-delete and correction are designed to preserve.
    const result = await prisma.prescription.findUnique({
        where: {
            id: id
        },
        include: {
            medicines: true,
            supersedes: { select: { id: true, status: true, createdAt: true } },
            supersededBy: { select: { id: true, status: true, createdAt: true } },
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
            patientId: userId,
            ...ACTIVE_PRESCRIPTION_FILTER
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
            ...ACTIVE_PRESCRIPTION_FILTER
        },
        include: {
            medicines: true,
            patient: true
        }
    })
    return result;
}

// Pass 13: was a hard delete before this pass, despite the schema comment on
// Prescription.deletedAt (added in Pass 2) explicitly flagging this as Pass 13's job —
// "Prescriptions are medical/legal records and should never be hard-deleted going
// forward." Same soft-delete convention as Pass 12's Patient.deletePatient: set
// deletedAt, leave the row (and everything referencing it — Medicine rows, any
// supersedes/supersededBy link) intact.
const deletePrescription = async (reqUser: any, id: string): Promise<any> => {
    // Pass 4: previously no ownership check at all — any doctor (the route also allows
    // admin) could delete any other doctor's prescription record.
    const existing = await prisma.prescription.findFirst({ where: { id, ...ACTIVE_PRESCRIPTION_FILTER } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    if (!isAdmin && existing.doctorId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to delete this prescription !!');
    }
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.prescription.update({
            where: { id },
            data: { deletedAt: new Date() }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'prescription.deleted',
                entityType: 'Prescription',
                entityId: id,
                metadata: {},
            }
        });
        return updated;
    });
    return result;
}

// Pass 13: companion to the soft-delete above — admin-only restore, same convention as
// Pass 12's Patient.reactivatePatient.
const reactivatePrescription = async (reqUser: any, id: string): Promise<Prescription> => {
    if (reqUser?.role !== 'admin') {
        throw new ApiError(httpStatus.FORBIDDEN, 'Only an admin can restore a deleted prescription !!');
    }
    const existing = await prisma.prescription.findUnique({ where: { id } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!');
    }
    if (!existing.deletedAt) {
        throw new ApiError(httpStatus.CONFLICT, 'This prescription is not deleted !!');
    }
    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.prescription.update({
            where: { id },
            data: { deletedAt: null }
        });
        await tx.auditLog.create({
            data: {
                actorId: reqUser?.userId,
                actorRole: reqUser?.role,
                action: 'prescription.restored',
                entityType: 'Prescription',
                entityId: id,
                metadata: {},
            }
        });
        return updated;
    });
    return result;
}

export const PrescriptionService = {
    createPrescription,
    getDoctorPrescriptionById,
    getPatientPrescriptionById,
    deletePrescription,
    reactivatePrescription,
    getPrescriptionById,
    getAllPrescriptions,
    updatePrescriptionAndAppointment,
    markPrescriptionFulfilled,
    archivePrescription,
}