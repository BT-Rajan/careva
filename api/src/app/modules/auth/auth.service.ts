import bcrypt from 'bcrypt';
import prisma from "../../../shared/prisma";
import ApiError from '../../../errors/apiError';
import httpStatus from 'http-status';
import { JwtHelper } from '../../../helpers/jwtHelper';
import config from '../../../config';
import { Secret } from 'jsonwebtoken';
import moment from 'moment';
import { NotificationService } from '../notification/notification.service';
const { v4: uuidv4 } = require('uuid');
import * as path from 'path';

type ILginResponse = {
    accessToken?: string;
    user: {}
}

// Pass 3: brute-force protection. Rate limiting (IP-based, see auth.route.ts) catches
// distributed/scripted attempts; this catches slow, targeted attempts against one
// account regardless of source IP.
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ACCOUNT_LOCK_MINUTES = 15;

const loginUser = async (user: any): Promise<ILginResponse> => {
    const { email: IEmail, password } = user;
    const email = typeof IEmail === 'string' ? IEmail.trim().toLowerCase() : IEmail;
    const isUserExist = await prisma.auth.findUnique({
        where: { email }
    })

    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, "User is not Exist !");
    }

    if (isUserExist.lockedUntil && moment(isUserExist.lockedUntil).isAfter(moment())) {
        const minutesLeft = Math.ceil(moment(isUserExist.lockedUntil).diff(moment(), 'seconds') / 60);
        throw new ApiError(httpStatus.FORBIDDEN, `Account temporarily locked due to repeated failed login attempts. Try again in ${minutesLeft} minute(s).`);
    }

    // check Verified doctor or not
    if (isUserExist.role === 'doctor') {
        const getDoctorInfo = await prisma.doctor.findUnique({
            where: {
                email: isUserExist.email
            }
        })
        if (getDoctorInfo && getDoctorInfo?.verified === false) {
            throw new ApiError(httpStatus.NOT_FOUND, "Please Verify Your Email First !");
        }
        // Pass 10 — Doctor Lifecycle. Separate from the email-verification check above —
        // a doctor can be fully email-verified and still SUSPENDED or DEACTIVATED. Does
        // NOT block PENDING_APPROVAL or REJECTED: a doctor should still be able to log
        // in to see their status and finish/fix their profile while awaiting or
        // recovering from a review decision.
        if (getDoctorInfo && (getDoctorInfo.approvalStatus === 'SUSPENDED' || getDoctorInfo.approvalStatus === 'DEACTIVATED')) {
            throw new ApiError(httpStatus.FORBIDDEN, `Your account is ${getDoctorInfo.approvalStatus.toLowerCase()}. Contact support if you believe this is a mistake.`);
        }
    }
    const isPasswordMatched = await bcrypt.compare(password, isUserExist.password);

    if (!isPasswordMatched) {
        const attempts = (isUserExist.failedLoginAttempts ?? 0) + 1;
        const shouldLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
        await prisma.auth.update({
            where: { id: isUserExist.id },
            data: {
                failedLoginAttempts: shouldLock ? 0 : attempts,
                lockedUntil: shouldLock ? moment().add(ACCOUNT_LOCK_MINUTES, 'minutes').toDate() : null
            }
        });
        // Pass 22 — Audit & Observability. Pass 3 built the failed-attempt counter and
        // lockout, but nothing recorded WHEN a failed attempt happened or WHEN an
        // account got locked — only the current count, which resets on the next
        // success and carries no history. An admin investigating "was this account
        // targeted" had literally nothing to look at.
        await prisma.auditLog.create({
            data: {
                actorId: isUserExist.userId,
                actorRole: isUserExist.role,
                action: shouldLock ? 'auth.account_locked' : 'auth.failed_login',
                entityType: 'Auth',
                entityId: isUserExist.id,
                metadata: { attempts, email: isUserExist.email },
            }
        });
        if (shouldLock) {
            throw new ApiError(httpStatus.FORBIDDEN, `Too many failed login attempts. Account locked for ${ACCOUNT_LOCK_MINUTES} minutes.`);
        }
        throw new ApiError(httpStatus.NOT_FOUND, "Password is not Matched !");
    }

    if (isUserExist.failedLoginAttempts) {
        await prisma.auth.update({
            where: { id: isUserExist.id },
            data: { failedLoginAttempts: 0, lockedUntil: null }
        });
    }
    // Pass 22: the other half of the picture — a record of successful logins is what
    // makes the failed-attempt trail above actually useful for investigation (e.g.
    // "were there failed attempts immediately before this successful one, from a
    // pattern that looks like the attacker eventually guessed right").
    await prisma.auditLog.create({
        data: {
            actorId: isUserExist.userId,
            actorRole: isUserExist.role,
            action: 'auth.login_succeeded',
            entityType: 'Auth',
            entityId: isUserExist.id,
            metadata: { email: isUserExist.email },
        }
    });

    const { role, userId, isDemo, email: userEmail } = isUserExist;
    const accessToken = JwtHelper.createToken(
        { role, userId, email: userEmail, isDemo: role === 'admin' ? Boolean(isDemo) : false },
        config.jwt.secret as Secret,
        config.jwt.JWT_EXPIRES_IN as string
    )
    return {
        accessToken,
        user: { role, userId, email: userEmail, isDemo: role === 'admin' ? Boolean(isDemo) : false },
    }
}

const VerificationUser = async (user: any): Promise<ILginResponse> => {
    const { email: IEmail, password } = user;
    const email = typeof IEmail === 'string' ? IEmail.trim().toLowerCase() : IEmail;
    const isUserExist = await prisma.auth.findUnique({
        where: { email }
    })

    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, "User is not Exist !");
    }
    const isPasswordMatched = await bcrypt.compare(password, isUserExist.password);

    if (!isPasswordMatched) {
        throw new ApiError(httpStatus.NOT_FOUND, "Password is not Matched !");
    }
    const { role, userId, isDemo, email: userEmail } = isUserExist;
    const accessToken = JwtHelper.createToken(
        { role, userId, email: userEmail, isDemo: role === 'admin' ? Boolean(isDemo) : false },
        config.jwt.secret as Secret,
        config.jwt.JWT_EXPIRES_IN as string
    )
    return {
        accessToken,
        user: { role, userId, email: userEmail, isDemo: role === 'admin' ? Boolean(isDemo) : false },
    }
}

const resetPassword = async (payload: any): Promise<{ message: string }> => {
    const { email: IEmail } = payload;
    const email = typeof IEmail === 'string' ? IEmail.trim().toLowerCase() : IEmail;
    const isUserExist = await prisma.auth.findUnique({
        where: { email }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, "User is not Exist !");
    }
    const clientUrl = `${config.clientUrl}/reset-password/`
    const uniqueString = uuidv4() + isUserExist.id;
    const uniqueStringHashed = await bcrypt.hashSync(uniqueString, 12);
    const encodedUniqueStringHashed = uniqueStringHashed.replace(/\//g, '-');

    const resetLink = clientUrl + isUserExist.id + '/' + encodedUniqueStringHashed;
    const currentTime = moment();
    const expiresTime = moment(currentTime).add(4, 'hours');

    const forgotPassword = await prisma.$transaction(async (tx) => {
        // BUG FIX (Pass 3): this previously looked up an existing request by
        // `id: isUserExist.id` — but ForgotPassword rows get their own auto-generated
        // `id`, never `isUserExist.id`, so this never matched anything and every reset
        // request silently left the previous one active. Corrected to look up (and clear
        // all of, in case more than one is stale) by the actual `userId` column.
        await tx.forgotPassword.deleteMany({
            where: { userId: isUserExist.id }
        });

        return tx.forgotPassword.create({
            data: {
                userId: isUserExist.id,
                expiresAt: expiresTime.toDate(),
                uniqueString: resetLink
            }
        });
    });

    // Pass 16 BUG FIX: this used to run INSIDE the transaction above, `await`ed
    // directly with a try/catch that re-threw on failure — meaning a flaky mail
    // provider would roll back the ForgotPassword row this same transaction had just
    // created, and the whole "forgot password" request would 500 despite the reset
    // token itself being perfectly valid to have issued. Moved out of the transaction
    // and onto dispatchNotification, which never throws and persists the attempt for
    // tracking/retry instead of the token creation and the email being coupled to each
    // other's success.
    if (forgotPassword) {
        const pathName = path.join(__dirname, '../../../../template/resetPassword.html')
        NotificationService.dispatchNotification({
            recipientId: isUserExist.userId,
            recipientRole: isUserExist.role,
            recipientEmail: isUserExist.email,
            event: 'auth.password_reset_requested',
            subject: 'Request to Reset Password',
            pathName,
            replacementObj: { link: resetLink },
            relatedEntityType: 'Auth',
            relatedEntityId: isUserExist.id,
        }).catch((err) => console.error('Failed to dispatch password-reset notification:', err));
    }


    return {
        message: "Password Reset Successfully !!"
    };
}

const PassworResetConfirm = async (payload: any): Promise<any> => {
    const { userId, uniqueString, password } = payload;

    await prisma.$transaction(async (tx) => {
        const isUserExist = await tx.auth.findUnique({
            where: { id: userId }
        });

        if (!isUserExist) { throw new ApiError(httpStatus.NOT_FOUND, "User is not Exist !") };
        const resetLink = `${config.clientUrl}/reset-password/${isUserExist.id}/${uniqueString}`
        const getForgotRequest = await tx.forgotPassword.findFirst({
            where: {
                userId: userId as string,
                uniqueString: resetLink
            }
        })
        if (!getForgotRequest) { throw new ApiError(httpStatus.NOT_FOUND, "Forgot Request was not found or Invalid !") };

        const expiresAt = moment(getForgotRequest.expiresAt);
        const currentTime = moment();
        if (expiresAt.isBefore(currentTime)) {
            throw new ApiError(httpStatus.NOT_FOUND, "Forgot Request has been expired !")
        } else {
            await tx.auth.update({
                where: {
                    id: userId
                },
                data: {
                    password: password && await bcrypt.hashSync(password, 12)
                }
            });
            await prisma.forgotPassword.delete({
                where: {
                    id: getForgotRequest.id
                }
            })
        }
    });
    return {
        message: "Password Changed Successfully !!"
    }
}

// Pass 3: "Credential-change behavior" — previously there was no way for a logged-in
// user to change their own password; only the unauthenticated forgot-password flow
// existed. Requires the current password, unlike the reset flow (which exists precisely
// for when the user *can't* provide their current password).
const changePassword = async (reqUser: any, payload: any): Promise<{ message: string }> => {
    const userId = reqUser?.userId;
    if (!userId) {
        throw new ApiError(httpStatus.UNAUTHORIZED, "Not authenticated !!");
    }
    const { currentPassword, newPassword } = payload;
    if (!currentPassword || !newPassword) {
        throw new ApiError(httpStatus.BAD_REQUEST, "currentPassword and newPassword are required !");
    }
    const isUserExist = await prisma.auth.findUnique({
        where: { id: userId }
    });
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, "User is not Exist !");
    }
    const isPasswordMatched = await bcrypt.compare(currentPassword, isUserExist.password);
    if (!isPasswordMatched) {
        throw new ApiError(httpStatus.FORBIDDEN, "Current password is incorrect !");
    }
    await prisma.auth.update({
        where: { id: userId },
        data: {
            password: await bcrypt.hashSync(newPassword, 12)
        }
    });
    return {
        message: "Password Changed Successfully !!"
    }
}

export const AuthService = {
    loginUser,
    VerificationUser,
    resetPassword,
    PassworResetConfirm,
    changePassword
}