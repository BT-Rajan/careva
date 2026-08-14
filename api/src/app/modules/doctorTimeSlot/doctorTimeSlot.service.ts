import httpStatus from "http-status";
import ApiError from "../../../errors/apiError";
import prisma from "../../../shared/prisma";
import { DoctorTimeSlot, ScheduleDay } from "@prisma/client";
import moment from "moment";

const createTimeSlot = async (user: any, payload: any): Promise<DoctorTimeSlot | null> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }

    const result = await prisma.$transaction(async (tx) => {
        const isAlreadyExist = await tx.doctorTimeSlot.findFirst({
            where:{
                doctorId: isDoctor.id,
                day: payload.day
            }
        })
        if(isAlreadyExist){
            throw new ApiError(404, 'Time Slot Already Exist Please update or try another day')
        }

        const createTimeSlot = await tx.doctorTimeSlot.create({
            data: {
                day: payload.day,
                doctorId: isDoctor.id,
                maximumPatient: payload.maximumPatient,
                weekDay: payload.weekDay,
                timeSlot: {
                    create: payload.timeSlot.map((item: any) => ({
                        startTime: item.startTime,
                        endTime: item.endTime
                    }))
                }
            }
        });

        return createTimeSlot;
    })
    // const tx = await prisma.$transaction(async() =>())

    // const result = await prisma.doctorTimeSlot.create({
    //     data: {
    //         day: payload.day,
    //         doctorId: isDoctor.id,
    //         maximumPatient: payload.maximumPatient,
    //         weekDay: payload.weekDay,
    //         timeSlot: {
    //             create: payload.timeSlot.map((item: any) => ({
    //                 startTime: item.startTime,
    //                 endTime: item.endTime
    //             }))
    //         }
    //     }
    // })
    return result;
}

const deleteTimeSlot = async (user: any, id: string): Promise<DoctorTimeSlot | null> => {
    // Pass 4: previously any authenticated doctor could delete ANY OTHER doctor's entire
    // schedule template by supplying an arbitrary id — no ownership check at all.
    const existing = await prisma.doctorTimeSlot.findUnique({ where: { id } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Time Slot is not found !!');
    }
    if (existing.doctorId !== user?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to delete this time slot !!');
    }
    const result = await prisma.doctorTimeSlot.delete({
        where: {
            id: id
        }
    })
    return result;
}

const getTimeSlot = async (user: any, id: string): Promise<DoctorTimeSlot | null> => {
    // Pass 4: previously any authenticated doctor could view ANY OTHER doctor's schedule
    // record by id — no ownership check at all.
    const result = await prisma.doctorTimeSlot.findFirst({
        where: {
            id: id
        }
    })
    if (result && result.doctorId !== user?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to view this time slot !!');
    }
    return result;
}

const getMyTimeSlot = async (user: any, filter: any): Promise<DoctorTimeSlot[] | null> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    let andCondition: any = { doctorId: isDoctor.id };
    if (filter.day) {
        andCondition.day = filter.day
    }

    const whereCondition = andCondition ? andCondition : {}
    const result = await prisma.doctorTimeSlot.findMany({
        where: whereCondition,
        include: {
            timeSlot: true
        }
    })
    return result;
}

const getAllTimeSlot = async (): Promise<DoctorTimeSlot[] | null> => {
    const result = await prisma.doctorTimeSlot.findMany({
        include: {
            timeSlot: true,
            doctor: {
                select: {
                    firstName: true,
                    lastName: true
                }
            }
        }
    })
    return result;
}
const updateTimeSlot = async (user: any, id: string, payload: any): Promise<{ message: string }> => {
    const { userId } = user;
    const isDoctor = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    const { timeSlot, create } = payload;

    if (create && create.length > 0) {
        // Pass 4 CRITICAL FIX: this previously looked up the target DoctorTimeSlot by
        // `day` ALONE, with no `doctorId` filter — meaning it could find and attach new
        // ScheduleDay rows to a DIFFERENT doctor's time-slot template, if that doctor
        // happened to already have a row for the same day. Scoped to the authenticated
        // doctor's own record.
        const doctorTimeSlot = await prisma.doctorTimeSlot.findFirst({
            where: {
                day: create[0].day,
                doctorId: isDoctor.id
            }
        })
        if (!doctorTimeSlot) {
            throw new ApiError(httpStatus.NOT_FOUND, 'Time Slot is not found !!')
        }
        await Promise.all(create.map(async (item: ScheduleDay) => {
            try {
                await prisma.scheduleDay.create({
                    data: {
                        startTime: item.startTime,
                        endTime: item.endTime,
                        doctorTimeSlotId: doctorTimeSlot?.id
                    }
                })
            } catch (error) {
                throw new ApiError(httpStatus.EXPECTATION_FAILED, 'Failed to create')
            }
        }))
    }

    if (timeSlot && timeSlot.length > 0) {
        // Pass 4 CRITICAL FIX: this previously updated ScheduleDay rows by id with NO
        // check that the row's parent DoctorTimeSlot belonged to the authenticated
        // doctor — any doctor could edit any other doctor's individual schedule entries
        // by supplying arbitrary ScheduleDay ids. The nested relation filter below makes
        // the update a no-op (0 rows) unless the row actually belongs to this doctor;
        // that's then treated as a failure rather than a silent success.
        await Promise.all(timeSlot.map(async (item: ScheduleDay) => {
            const { doctorTimeSlotId, ...others } = item;
            try {
                const updated = await prisma.scheduleDay.updateMany({
                    where: {
                        id: others.id,
                        doctorTimeSlot: { doctorId: isDoctor.id }
                    },
                    data: {
                        startTime: others.startTime,
                        endTime: others.endTime
                    }
                })
                if (updated.count === 0) {
                    throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this time slot !!')
                }
            } catch (error) {
                if (error instanceof ApiError) throw error;
                throw new ApiError(httpStatus.EXPECTATION_FAILED, 'Failed to Update')
            }
        }))
    }
    return {
        message: 'Successfully Updated'
    }
}

const getAppointmentTimeOfEachDoctor = async (id: string, filter: any): Promise<any> => {
    const doctorTimSlot = await prisma.doctorTimeSlot.findMany({
        where: {
            doctorId: id
        },
        include: {
            timeSlot: true
        },
    })

    const allSlots = doctorTimSlot.map((item) => {
        const { day, timeSlot, ...others } = item;
        return { day, timeSlot }
    })

    const generateTimeSlot = (timeSlot: any) => {
        const selectedTime: any[] = [];
        timeSlot.forEach((item: any) => {
            const interval = 30;
            const newTimeSlots: any[] = [];
            const day: string = item?.day;

            item?.timeSlot.map((slot: ScheduleDay) => {

                const { startTime, endTime } = slot;
                const startDate = moment(startTime, 'hh:mm a');
                const endDate = moment(endTime, 'hh:mm a');

                while (startDate < endDate) {
                    const selectableTime = {
                        id: newTimeSlots.length + 1,
                        time: startDate.format('hh:mm a')
                    }
                    newTimeSlots.push({ day: day, slot: selectableTime });
                    startDate.add(interval, 'minutes');
                }
            })
            if (filter.day) {
                const newTime = newTimeSlots.filter((item) => item.day === filter.day);
                selectedTime.push(newTime);
            }
        })
        return selectedTime.flat();
    }
    const result = generateTimeSlot(allSlots)
    return result
}

export const TimeSlotService = {
    updateTimeSlot,
    getAllTimeSlot,
    getTimeSlot,
    createTimeSlot,
    deleteTimeSlot,
    getMyTimeSlot,
    getAppointmentTimeOfEachDoctor
}