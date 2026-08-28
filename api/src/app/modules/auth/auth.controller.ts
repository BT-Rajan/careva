import { Request, Response } from "express";
import bcrypt from 'bcrypt';
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { AuthService } from "./auth.service";
import config from "../../../config";
import path from 'path';
import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import moment from "moment";

const Login = catchAsync(async (req: Request, res: Response) => {
    const result = await AuthService.loginUser(req.body);
    const { accessToken } = result;

    // Pass 19 — Security Hardening. This cookie isn't actually read anywhere today —
    // auth.ts's middleware only checks the Authorization header (see
    // helpers/axios/axiosInstance.js, which attaches the token from localStorage) — but
    // it's still a real Set-Cookie carrying a raw JWT into the browser, and hardening it
    // costs nothing. `sameSite: 'lax'` is explicit here rather than left to each
    // browser's own default (browsers do default un-annotated cookies to Lax today, but
    // relying on an implicit default for a security property is fragile — it should be
    // a decision this code visibly makes, not an accident of whichever browser a
    // request happens to come from). Matched on clearCookie below — mismatched
    // attributes between set and clear is a common reason a "logout" silently fails to
    // actually remove the cookie.
    const cookieOptions = {
        secure: config.env === 'production',
        httpOnly: true,
        sameSite: 'lax' as const,
    }
    res.cookie('accessToken', accessToken, cookieOptions)
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Logged !!',
        success: true,
        data: result,
    })
})
const resetPassword = catchAsync(async (req: Request, res: Response) => {
    const result = await AuthService.resetPassword(req.body);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Passwrod Reset!!',
        success: true,
        data: result,
    })
})

const PasswordResetConfirm = catchAsync(async (req: Request, res: Response) => {
    const result = await AuthService.PassworResetConfirm(req.body);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Passwrod Changed!!',
        success: true,
        data: result,
    })
})

const VerifyUser = catchAsync(async (req: Request, res: Response) => {
    const { userId, uniqueString } = req.params;
    const isUserExist = await prisma.doctor.findUnique({
        where: {
            id: userId
        }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, "User is not found !!");
    }
    const getVerficationUser = await prisma.userVerfication.findFirst({
        where: {
            userId: userId
        }
    })
    if (getVerficationUser) {
        // SECURITY FIX (Pass 3): the `uniqueString` route param was previously read but
        // never compared against the stored (bcrypt-hashed) token before marking the
        // account verified — meaning anyone who knew/guessed a doctor's userId could
        // verify that account within the 6-hour window without ever receiving the real
        // email link. The token is now actually checked before proceeding.
        const isTokenValid = await bcrypt.compare(uniqueString, getVerficationUser.uniqueString as string);
        if (!isTokenValid) {
            return res.redirect('/api/v1/auth/expired/link');
        }
        const expiresAt = moment(getVerficationUser.expiresAt);
        const currentTime = moment();
        // check currenttime is before then expires Time
        const isWithinNext6Hours = currentTime.isBefore(expiresAt);

        if (isWithinNext6Hours) {
            await prisma.$transaction(async (tx) => {
                await tx.doctor.update({
                    where: {
                        id: isUserExist.id
                    },
                    data: {
                        verified: true
                    }
                });
                await tx.userVerfication.delete({
                    where: {
                        id: getVerficationUser.id
                    }
                })
            })
            res.redirect('/api/v1/auth/verified');
        } else {
            res.redirect('/api/v1/auth/expired/link');
        }
    } else {
        res.redirect('/api/v1/auth/expired/link');
    }
})

const Verified = catchAsync(async (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "../../../../template/verfied.html"))
})

const VerficationExpired = catchAsync(async (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "../../../../template/expiredVarification.html"))
})

const Logout = catchAsync(async (req: Request, res: Response) => {
    // JWTs issued by this API are stateless (see docs/passes/03-authentication.md) — the
    // server cannot force-invalidate a bearer token that a client already holds. This
    // clears the (currently redundant) accessToken cookie and gives the frontend a real
    // endpoint to call on logout, but a token captured before logout remains valid until
    // it naturally expires. True server-side invalidation needs a stateful token/session
    // store, which is a stack decision this pass does not make unilaterally.
    // Pass 19: sameSite must match what Login set above, or the browser treats it as a
    // different cookie and clearCookie silently does nothing.
    const cookieOptions = {
        secure: config.env === 'production',
        httpOnly: true,
        sameSite: 'lax' as const,
    }
    res.clearCookie('accessToken', cookieOptions);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Logged Out !!',
        success: true,
        data: null,
    })
})

const ChangePassword = catchAsync(async (req: Request, res: Response) => {
    // req.user is populated by the `auth()` middleware — this route requires a valid
    // access token, unlike resetPassword/PasswordResetConfirm which are for users who
    // are locked out and can't log in at all.
    const result = await AuthService.changePassword(req.user, req.body);
    sendResponse(res, {
        statusCode: 200,
        message: 'Successfully Password Changed !!',
        success: true,
        data: result,
    })
})

export const AuthController = {
    Login,
    Logout,
    VerifyUser,
    Verified,
    VerficationExpired,
    resetPassword,
    PasswordResetConfirm,
    ChangePassword
}