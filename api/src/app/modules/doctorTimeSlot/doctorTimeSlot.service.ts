import httpStatus from "http-status";
import ApiError from "../../../errors/apiError";
import prisma from "../../../shared/prisma";
import { DoctorTimeSlot, ScheduleDay } from "@prisma/client";
import moment from "moment";

// Pass 11 — Doctor Schedule Engine.
const TIME_FORMATS = ['hh:mm a', 'HH:mm'];

const assertValidTimeRange = (startTime: string, endTime: string) => {
    const start = moment(startTime, TIME_FORMATS, true);
    const end = moment(endTime, TIME_FORMATS, true);
    if (!start.isValid() || !end.isValid()) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Invalid time value: "${startTime}" / "${endTime}".`);
    }
    if (!start.isBefore(end)) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Start time (${startTime}) must be before end time (${endTime}).`);
    }
}

const rangesOverlap = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean => {
    const s1 = moment(aStart, TIME_FORMATS), e1 = moment(aEnd, TIME_FORMATS);
    const s2 = moment(bStart, TIME_FORMATS), e2 = moment(bEnd, TIME_FORMATS);
    return s1.isBefore(e2) && s2.isBefore(e1);
}

/**
 * Previously NOTHING validated that a doctor's submitted time ranges for one day didn't
 * overlap each other (e.g. "9-12" and "10-13" for the same Monday) — both would be
 * created, silently producing duplicate/overlapping generated slots. Checks the new
 * range against both its siblings-to-be (other ranges in the same submission) and any
 * already-existing ranges for that day, optionally excluding one id (for in-place edits).
 */
const assertNoOverlap = (newRange: { startTime: string; endTime: string }, existing: { id?: number; startTime: string; endTime: string }[], excludeId?: number) => {
    for (const other of existing) {
        if (excludeId !== undefined && other.id === excludeId) continue;
        if (rangesOverlap(newRange.startTime, newRange.endTime, other.startTime, other.endTime)) {
            throw new ApiError(httpStatus.CONFLICT, `Time range ${newRange.startTime}–${newRange.endTime} overlaps an existing range (${other.startTime}–${other.endTime}).`);
        }
    }
}

/**
 * Schedule deletion/modification rules — previously a doctor (or admin) could delete an
 * entire day's schedule, or shrink a time range, with zero regard for appointments
 * already booked in the affected window. `scheduleDate` is a free-text string (not a
 * proper Date column — see Pass 1's domain model), so weekday matching is done in
 * application code after fetching the doctor's future non-cancelled appointments, not in
 * the SQL query itself; the doctor's future appointment count is small enough for this to
 * be fine performance-wise.
 */
const CANCEL_LIKE_STATUSES = ['DECLINED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_DOCTOR', 'CANCELLED_BY_ADMIN', 'EXPIRED'];

const getFutureActiveAppointmentsForWeekday = async (doctorId: string, day: string) => {
    const appointments = await prisma.appointments.findMany({
        where: {
            doctorId,
            status: { notIn: CANCEL_LIKE_STATUSES as any },
        },
        select: { id: true, scheduleDate: true, scheduleTime: true }
    });
    const today = moment().startOf('day');
    return appointments.filter((a) => {
        if (!a.scheduleDate) return false;
        const d = moment(a.scheduleDate);
        return d.isValid() && !d.isBefore(today) && d.format('dddd').toLowerCase() === day.toLowerCase();
    });
}

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

    const submittedRanges: { startTime: string; endTime: string }[] = payload.timeSlot ?? [];
    for (const range of submittedRanges) {
        assertValidTimeRange(range.startTime, range.endTime);
    }
    // Pairwise overlap check among the ranges being submitted together.
    submittedRanges.forEach((range, i) => {
        assertNoOverlap(range, submittedRanges.filter((_, j) => j !== i));
    });

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
                    create: submittedRanges.map((item) => ({
                        startTime: item.startTime,
                        endTime: item.endTime
                    }))
                }
            }
        });

        return createTimeSlot;
    })
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
    // Pass 11: schedule deletion rule — don't silently orphan a patient who already has a
    // future appointment booked on this weekday. Forces an explicit decision (cancel
    // those appointments first, through the proper cancellation flow — Pass 9 — which
    // handles refunds correctly) rather than quietly deleting the schedule they were
    // booked against.
    if (existing.day) {
        const affected = await getFutureActiveAppointmentsForWeekday(existing.doctorId, existing.day);
        if (affected.length > 0) {
            throw new ApiError(httpStatus.CONFLICT, `Cannot delete this schedule — ${affected.length} upcoming appointment(s) are booked on ${existing.day}. Cancel or reschedule them first.`);
        }
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
            },
            include: { timeSlot: true }
        })
        if (!doctorTimeSlot) {
            throw new ApiError(httpStatus.NOT_FOUND, 'Time Slot is not found !!')
        }
        // Pass 11: validate + check overlap against existing ranges for this day AND
        // against each other, before creating anything — previously neither check
        // existed, so a doctor could add "9-12" and "10-13" for the same day and both
        // would silently be created.
        for (const item of create as { startTime: string; endTime: string }[]) {
            assertValidTimeRange(item.startTime, item.endTime);
        }
        (create as { startTime: string; endTime: string }[]).forEach((item, i) => {
            assertNoOverlap(item, [
                ...doctorTimeSlot.timeSlot,
                ...(create as { startTime: string; endTime: string }[]).filter((_, j) => j !== i)
            ]);
        });
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

            // Pass 11: validate the new range, fetch what it's replacing (for overlap +
            // shrink checks), and load the sibling ranges for the same day to check
            // overlap against — all before writing anything.
            assertValidTimeRange(others.startTime, others.endTime);
            const before = await prisma.scheduleDay.findFirst({
                where: { id: others.id, doctorTimeSlot: { doctorId: isDoctor.id } },
                include: { doctorTimeSlot: { include: { timeSlot: true } } }
            });
            if (!before || !before.doctorTimeSlot) {
                throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this time slot !!');
            }
            assertNoOverlap(others, before.doctorTimeSlot.timeSlot, others.id as number);

            // Schedule modification rule: shrinking a range must not orphan a patient
            // already booked within the portion being removed. Growing a range, or
            // moving it without shrinking the covered portion, is always fine.
            if (before.doctorTimeSlot.day) {
                const affected = await getFutureActiveAppointmentsForWeekday(isDoctor.id, before.doctorTimeSlot.day);
                const oldStart = moment(before.startTime, TIME_FORMATS);
                const oldEnd = moment(before.endTime, TIME_FORMATS);
                const newStart = moment(others.startTime, TIME_FORMATS);
                const newEnd = moment(others.endTime, TIME_FORMATS);
                const orphaned = affected.filter((a) => {
                    const t = moment(a.scheduleTime, TIME_FORMATS);
                    if (!t.isValid()) return false;
                    const wasInOldRange = t.isSameOrAfter(oldStart) && t.isBefore(oldEnd);
                    const isInNewRange = t.isSameOrAfter(newStart) && t.isBefore(newEnd);
                    return wasInOldRange && !isInNewRange;
                });
                if (orphaned.length > 0) {
                    throw new ApiError(httpStatus.CONFLICT, `Cannot shrink this time range — ${orphaned.length} upcoming appointment(s) fall outside the new range. Cancel or reschedule them first.`);
                }
            }

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

// Pass 11 — Doctor Schedule Engine: "availability recalculation." Previously this
// function generated every theoretically-possible 30-minute slot from the doctor's
// configured hours and returned all of them, with zero connection to existing bookings,
// capacity, or blocked dates — a fully-booked slot looked exactly as available as an
// empty one (flagged as a known gap since Pass 5). Now accepts an actual calendar `date`
// (not just a weekday name) and:
//   1. returns nothing at all if that date is blocked (DoctorBlockedDate)
//   2. excludes any time already at capacity for that specific date
// `date` is optional for backward compatibility with any caller that still only wants
// the theoretical weekly template (e.g. a doctor reviewing their own configured hours) —
// capacity/blocked-date filtering only applies when a real date is provided.
const getAppointmentTimeOfEachDoctor = async (id: string, filter: any): Promise<any> => {
    // Normalized the same way as assertSlotAvailable in appointment.service.ts — see
    // its comment for why exact-string matching the raw date would be fragile.
    const normalizedDate = filter.date ? moment(filter.date).format('YYYY-MM-DD') : undefined;
    if (normalizedDate) {
        const blocked = await prisma.doctorBlockedDate.findUnique({
            where: { doctorId_date: { doctorId: id, date: normalizedDate } }
        });
        if (blocked) {
            return [];
        }
    }

    const doctorTimSlot = await prisma.doctorTimeSlot.findMany({
        where: {
            doctorId: id
        },
        include: {
            timeSlot: true
        },
    })

    const allSlots = doctorTimSlot.map((item) => {
        const { day, timeSlot, maximumPatient } = item;
        return { day, timeSlot, maximumPatient: maximumPatient ?? 1 }
    })

    const matchingDaySlot = allSlots.find((s) => filter.day && s.day === filter.day);

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
                    newTimeSlots.push({ day: day, slot: selectableTime, maximumPatient: item.maximumPatient });
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
    let result = generateTimeSlot(allSlots);

    // Availability recalculation: only meaningful once we know which specific calendar
    // date is being asked about (capacity is per doctor+date+time, not per weekday).
    // Deliberately uses the RAW filter.date here (not normalizedDate above) — this must
    // exact-match whatever string the frontend sends as Appointments.scheduleDate at
    // booking time, so the caller is responsible for sending the same date format to
    // both this endpoint and the actual booking submission. See
    // SelectApppointment.jsx, which does exactly that.
    if (filter.date && matchingDaySlot) {
        const existingCounts = await prisma.appointments.groupBy({
            by: ['scheduleTime'],
            where: {
                doctorId: id,
                scheduleDate: filter.date,
                status: { notIn: CANCEL_LIKE_STATUSES as any }
            },
            _count: { scheduleTime: true }
        });
        const countByTime = new Map(existingCounts.map((c) => [c.scheduleTime, c._count.scheduleTime]));
        result = result.filter((entry: any) => {
            const bookedCount = countByTime.get(entry.slot.time) ?? 0;
            return bookedCount < (matchingDaySlot.maximumPatient ?? 1);
        });
    }

    return result
}

// Pass 11 — Doctor Schedule Engine: blocked dates / holidays. Flagged as a gap since
// Pass 5 ("no schema concept of 'closed on Dec 25' or 'on vacation March 1-15' at all").
const createBlockedDate = async (user: any, date: string, reason?: string): Promise<any> => {
    const isDoctor = await prisma.doctor.findUnique({ where: { id: user.userId } });
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
    }
    const parsed = moment(date);
    if (!parsed.isValid()) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Invalid date: "${date}".`);
    }
    // Normalized to YYYY-MM-DD regardless of what format the client sent — see the
    // matching normalization in appointment.service.ts's assertSlotAvailable and this
    // file's getAppointmentTimeOfEachDoctor.
    const normalizedDate = parsed.format('YYYY-MM-DD');
    try {
        return await prisma.doctorBlockedDate.create({
            data: { doctorId: isDoctor.id, date: normalizedDate, reason }
        });
    } catch (error: any) {
        if (error?.code === 'P2002') {
            throw new ApiError(httpStatus.CONFLICT, 'This date is already blocked.');
        }
        throw error;
    }
}

const deleteBlockedDate = async (user: any, id: string): Promise<any> => {
    const existing = await prisma.doctorBlockedDate.findUnique({ where: { id } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Blocked date is not found !!');
    }
    if (existing.doctorId !== user?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to remove this blocked date !!');
    }
    return prisma.doctorBlockedDate.delete({ where: { id } });
}

const getMyBlockedDates = async (user: any): Promise<any> => {
    const isDoctor = await prisma.doctor.findUnique({ where: { id: user.userId } });
    if (!isDoctor) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!');
    }
    return prisma.doctorBlockedDate.findMany({
        where: { doctorId: isDoctor.id },
        orderBy: { date: 'asc' }
    });
}

export const TimeSlotService = {
    updateTimeSlot,
    getAllTimeSlot,
    getTimeSlot,
    createTimeSlot,
    deleteTimeSlot,
    getMyTimeSlot,
    getAppointmentTimeOfEachDoctor,
    createBlockedDate,
    deleteBlockedDate,
    getMyBlockedDates,
}