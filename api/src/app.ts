import express, { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import CookieParser from 'cookie-parser';
import httpStatus from 'http-status';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import ApiError from './errors/apiError';
import handleZodError from './errors/handleZodError';
import handlePrismaError from './errors/handlePrismaError';
import router from './app/routes';
import config from './config';

const app: Application = express();

// Pass 19 — Security Hardening. This app runs behind a reverse proxy/load balancer in
// any real deployment (Railway, Render, Vercel's edge, nginx, etc.) — without `trust
// proxy`, Express sees every request as originating from the proxy's own IP, not the
// real client's. That silently breaks two things that already exist in this codebase:
// the IP-based rate limiters (loginRateLimiter, passwordResetRateLimiter, etc. — Pass
// 3/7) would rate-limit ALL users behind the proxy together as a single "client," and
// req.ip would be useless for the AuditLog/abuse-investigation purposes those passes
// built it for. `1` (trust the first hop) is the standard, correct value for a single
// reverse-proxy deployment; a bare `true` would trust the entire X-Forwarded-For chain,
// which is spoofable by the client itself if there's no proxy actually rewriting it.
app.set('trust proxy', 1);

// Pass 19 — Security Hardening. Sets the standard defensive headers this app had none
// of before now: X-Content-Type-Options (blocks MIME-sniffing), X-Frame-Options /
// frame-ancestors (clickjacking), Strict-Transport-Security (forces HTTPS on repeat
// visits), and removes X-Powered-By (don't advertise the exact framework/version to a
// would-be attacker). Content-Security-Policy is left at helmet's conservative default
// rather than hand-tuned — this is a JSON API, not a page-rendering server (the only
// static content served is `public/`, checked below), so a strict hand-built CSP isn't
// worth the maintenance burden of tracking every asset origin the frontend (a separate
// deployment) might need; revisit if this server ever starts rendering HTML views
// itself.
app.use(helmet());

// Pass 19 BUG FIX: `cors()` with no options resolves to `Access-Control-Allow-Origin: *`
// — every origin on the internet could make cross-origin requests to this API and read
// the JSON response. The practical severity was limited (this app's real auth token
// lives in the frontend's localStorage and is attached manually via an Authorization
// header — see helpers/axios/axiosInstance.js — which a malicious third-party page has
// no way to read or forge; it isn't a cookie a browser would attach automatically), but
// "limited severity due to a different design choice" isn't a reason to leave an actual
// misconfiguration in place. Restricted to the known frontend origin(s); `credentials:
// true` matches the httpOnly cookie auth.controller.ts already sets on login (see the
// cookieOptions comment there) even though nothing currently reads that cookie back.
const allowedOrigins = [config.clientUrl].filter(Boolean) as string[];
app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
}));
app.use(CookieParser());

// Pass 7 — Payment System: webhook signature verification (Razorpay, and any future
// gateway that signs over the raw body) needs the EXACT raw bytes the gateway sent, not
// a re-serialized version of the parsed object (JSON.stringify(parsed) is not guaranteed
// to byte-for-byte match what was actually received — key ordering, whitespace, unicode
// escaping can all differ). Capturing it here via express.json()'s verify callback, once,
// globally, is simpler and less error-prone than trying to bypass the global JSON parser
// per-route (which doesn't work anyway — express.json() below would already have
// consumed the request stream by the time a route-level parser ran).
app.use(express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as any).rawBody = buf.toString('utf8');
    }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/favicon.ico', (req: Request, res: Response) => {
    res.status(204).end();
})

app.get('/', (req: Request, res: Response) => {
    res.send(config.clientUrl)
})

app.use('/api/v1', router);

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
        return next(err);
    }
    console.error('[api error]', req.method, req.originalUrl, err);
    if (err instanceof ApiError) {
        return res
            .status(err.statusCode)
            .json({ success: false, message: err.message });
    }
    // Pass 17 — API Contract. Two error types that could always be thrown (Zod, once
    // validateRequest actually started throwing them; Prisma's known-request errors,
    // always possible from any service function) previously had no dedicated branch
    // here at all and fell straight into the generic fallback below — a ZodError's
    // carefully-structured per-field issues, or a Prisma unique-constraint violation,
    // both collapsed into either a raw dumped message or an opaque 500. handleZodError
    // already existed (unused) for exactly this; handlePrismaError is this pass's new
    // equivalent for the ORM this app actually uses.
    if (err instanceof ZodError) {
        const { statusCode, message, errorMessages } = handleZodError(err);
        return res.status(statusCode).json({ success: false, message, errorMessages });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const { statusCode, message, errorMessages } = handlePrismaError(err);
        return res.status(statusCode).json({ success: false, message, errorMessages });
    }
    // Pass 18 — Error Handling & Recovery: distinct from PrismaClientKnownRequestError
    // above (which means the DATABASE responded, just with a client-input-shaped
    // problem like a unique-constraint violation). This is thrown when Prisma couldn't
    // reach the database at all — a transient infra condition, not anything about the
    // request itself, and not a bug in this codebase. 503 (with a message telling the
    // client to retry) is the honest signal here; previously this fell into the generic
    // fallback below and was indistinguishable from an actual server bug, both to
    // whoever's reading logs and to any client trying to decide whether retrying is
    // worthwhile.
    if (err instanceof Prisma.PrismaClientInitializationError) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: 'The database is temporarily unavailable. Please try again shortly.',
        });
    }
    const e = err as { statusCode?: number; message?: string; stack?: string; name?: string };
    const statusCode =
        typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600
            ? e.statusCode
            : httpStatus.INTERNAL_SERVER_ERROR;
    const body: Record<string, unknown> = {
        success: false,
        message: config.showErrorDetails
            ? e.message || String(err)
            : 'Something Went Wrong',
    };
    if (config.showErrorDetails && e.stack) {
        body.stack = e.stack;
    }
    if (config.showErrorDetails && e.name) {
        body.error = e.name;
    }
    return res.status(statusCode).json(body);
});

export default app;