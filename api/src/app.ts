import express, { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
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

app.use(cors());
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