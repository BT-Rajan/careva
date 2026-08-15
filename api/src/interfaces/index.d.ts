import { JwtPayload } from "jsonwebtoken";

declare global {
    namespace Express{
        interface Request{
            user: JwtPayload | null
            /** Pass 7 — Payment System: raw request body bytes, captured by
             *  express.json()'s verify callback in app.ts, for webhook signature
             *  verification that must operate over the exact bytes received. */
            rawBody?: string
        }
    }
}