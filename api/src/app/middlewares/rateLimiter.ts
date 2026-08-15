import rateLimit from 'express-rate-limit';

// Pass 3 — brute-force / abuse protection. In-memory (per-process) rate limiting; no new
// infrastructure required. This is IP-based and complements the per-account lockout in
// auth.service.ts (loginUser) — together they cover both a single attacker hammering many
// accounts, and a distributed attempt against one account.

/**
 * For login: fairly tight, since a legitimate user rarely needs more than a handful of
 * attempts in a short window.
 */
export const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

/**
 * For password-reset requests and confirmations: looser than login (real users can
 * legitimately retry a typo'd email or an expired link), but still bounded to prevent
 * mass-enumeration or token-guessing.
 */
export const passwordResetRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many password reset attempts. Please try again later.' }
});

/**
 * For the email-verification link: this is the endpoint the Pass 3 security fix
 * (auth.controller.ts VerifyUser) now actually checks a token against — rate limiting it
 * additionally slows down any attempt to brute-force the uniqueString token itself.
 */
export const verifyEmailRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many verification attempts. Please try again later.' }
});

/**
 * Pass 7 — Payment System. Webhook endpoints are unauthenticated by necessity (the
 * gateway calls them directly, not a logged-in user) — signature verification is the
 * real defense, but rate limiting adds a cheap extra layer against anything trying to
 * flood the endpoint before a signature is even checked. Deliberately generous: real
 * gateways can legitimately send bursts of webhooks (e.g. catching up after an outage),
 * so this should not be tight enough to cause Careva to reject legitimate gateway retries.
 */
export const paymentWebhookRateLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many webhook requests.' }
});
