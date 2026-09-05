import httpStatus from "http-status";
import ApiError from "../../../errors/apiError";
import prisma from "../../../shared/prisma";
import { UserRole } from "@prisma/client";
import bcrypt from 'bcrypt';

export const create = async (payload: any): Promise<any> => {
    try {
        // Pass 3: normalize email casing so "User@x.com" and "user@x.com" can't become
        // two different accounts — done in application code rather than relying on the
        // database collation, so behavior doesn't depend on whatever collation the
        // deployed database ends up using.
        if (typeof payload.email === 'string') {
            payload.email = payload.email.trim().toLowerCase();
        }
        const data = await prisma.$transaction(async (tx) => {
            const { password, ...othersData } = payload;

            const patient = await tx.patient.create({
                data: othersData,
            });

            if (patient) {
                // Check Email existing
                const existEmail = await tx.auth.findUnique({ where: { email: patient.email } });
                if (existEmail) {
                    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "Email Already Exist !!")
                } else {
                    const auth = await tx.auth.create({
                        data: {
                            email: patient.email,
                            password: password && await bcrypt.hashSync(password, 12),
                            role: UserRole.patient,
                            userId: patient.id
                        },
                    });
                    return {
                        patient,
                        auth,
                    };
                }
            }
        });

        return data;
    } catch (error: any) {
        throw new ApiError(httpStatus.BAD_REQUEST, error.message)
    }
};