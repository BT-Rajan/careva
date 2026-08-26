/**
 * Pass 17 — API Contract.
 *
 * `zod` has been a dependency since before this pass (see package.json), and
 * `errors/handleZodError.ts` was already written to format a ZodError into this app's
 * error-response shape — but nothing ever threw one. No route in this codebase
 * validated its request shape at all before handing `req.body` straight to a service
 * function typed `payload: any`. This is the middleware that actually makes
 * handleZodError's existence meaningful: it parses the incoming request against a
 * schema and calls `next(error)` on failure, letting the global error handler (see
 * app.ts) dispatch a ZodError to handleZodError the same way it already dispatches
 * ApiError to its own branch.
 *
 * Convention: every schema wraps body/query/params in one object — e.g.
 * `z.object({ body: z.object({...}) })` — even when only `body` is actually
 * constrained, so the shape is consistent and a schema can start validating query/params
 * later without changing how it's invoked.
 */
import { NextFunction, Request, Response } from 'express';
import { AnyZodObject } from 'zod';

const validateRequest = (schema: AnyZodObject) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        await schema.parseAsync({
            body: req.body,
            query: req.query,
            params: req.params,
        });
        return next();
    } catch (error) {
        next(error);
    }
};

export default validateRequest;
