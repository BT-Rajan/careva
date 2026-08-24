import { Medicine } from "@prisma/client";
import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";

const createMedicine = async (reqUser: any, payload: Medicine[]): Promise<{message : string}> => {
    // Pass 4: previously no ownership check at all — any authenticated doctor could
    // attach medicine line items to ANY prescription, including other doctors' patients'.
    const prescriptionIds = Array.from(new Set(payload.map((m) => m.prescriptionId)));
    const prescriptions = await prisma.prescription.findMany({
        where: { id: { in: prescriptionIds } }
    });
    if (prescriptions.length !== prescriptionIds.length) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!');
    }
    const notOwned = prescriptions.some((p) => p.doctorId !== reqUser?.userId);
    if (notOwned) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to add medicine to this prescription !!');
    }
    // Pass 13: a prescription's medicine list is part of its versioned clinical content
    // — closing the same gap that motivated updatePrescriptionAndAppointment's rewrite
    // into a real correction. Without this, a doctor could still add/edit/remove
    // medicines on a CORRECTED (superseded, supposed to stay intact) or ARCHIVED
    // prescription directly through this separate module, bypassing the lifecycle
    // entirely. Deleted (soft-deleted) prescriptions are caught by the NOT_FOUND check
    // above via the ACTIVE filter used elsewhere — enforced again here explicitly since
    // this module has its own findMany.
    const notMutable = prescriptions.some((p) => p.status !== 'ISSUED' || p.deletedAt !== null);
    if (notMutable) {
        throw new ApiError(httpStatus.CONFLICT, 'This prescription is no longer editable — issue a correction instead !!');
    }
    const createMedicinePromise = payload.map((medicine: Medicine) =>
        prisma.medicine.create({
            data: {
                dosage: medicine.dosage,
                duration: medicine.duration,
                frequency: medicine.frequency,
                medicine: medicine.medicine,
                prescriptionId: medicine.prescriptionId
            }
        })
    )
    await Promise.all(createMedicinePromise);
    return {
        message: "Successfully medicine added"
    }
}

const updateMedicine = async (reqUser: any, payload: Medicine): Promise<Medicine> => {
    const isPrescriptionId = await prisma.prescription.findUnique({
        where: {
            id: payload.prescriptionId
        }
    })
    if (!isPrescriptionId) { throw new ApiError(httpStatus.NOT_FOUND, 'Prescription is not found !!') }
    // Pass 4: previously no ownership check — any authenticated doctor could update any
    // medicine record regardless of which doctor's prescription it belonged to.
    if (isPrescriptionId.doctorId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this medicine !!');
    }
    // Pass 13: see the matching check in createMedicine.
    if (isPrescriptionId.status !== 'ISSUED' || isPrescriptionId.deletedAt !== null) {
        throw new ApiError(httpStatus.CONFLICT, 'This prescription is no longer editable — issue a correction instead !!');
    }

    const result = await prisma.medicine.update({
        where: {
            id: payload.id
        },
        data: {
            dosage: payload.dosage,
            duration: payload.duration,
            frequency: payload.frequency,
            medicine: payload.medicine
        }
    })
    return result;

}

const deleteMedicine = async (reqUser: any, id: string): Promise<Medicine> => {
    // Pass 4: previously no ownership check — any authenticated doctor could delete any
    // medicine record by id.
    const existing = await prisma.medicine.findUnique({
        where: { id },
        include: { prescription: true }
    });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Medicine is not found !!');
    }
    if (existing.prescription.doctorId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to delete this medicine !!');
    }
    // Pass 13: see the matching check in createMedicine.
    if (existing.prescription.status !== 'ISSUED' || existing.prescription.deletedAt !== null) {
        throw new ApiError(httpStatus.CONFLICT, 'This prescription is no longer editable — issue a correction instead !!');
    }
    const result = await prisma.medicine.delete({where: {id}})
    return result;
}

export const MedicineService = {
    updateMedicine,
    createMedicine,
    deleteMedicine
}