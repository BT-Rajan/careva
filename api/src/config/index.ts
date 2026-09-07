import dotenv from 'dotenv';
import path from 'path';

dotenv.config({path: path.join(process.cwd(), '.env')});

const clientUrl = process.env.NODE_ENV==="development" ? process.env.CLIENT__LOCAL_URL : process.env.CLIENT_URL

const showErrorDetails =
    process.env.NODE_ENV !== 'production' ||
    process.env.SHOW_ERROR_DETAILS === 'true';

export default {
    env: process.env.NODE_ENV,
    showErrorDetails,
    port: process.env.PORT,
    // Adversarial stress-test finding (post Pass 26): `defaultAdminDoctor` is the
    // fallback Doctor.id createAppointmentByUnAuthenticateUser uses when a guest
    // booking doesn't specify a doctor (see appointment.validation.ts's comment on
    // CreateAppointmentByUnAuthenticateUserValidation) — a real, live feature path, not
    // dead config. But the env var it read was `DEFULT_ADMIN_DOCTOR` (missing the
    // first "A"), and was never listed in api/.env.example or software_requirements.md
    // at all — a deployer had no way to discover it needed setting, and even someone
    // who noticed the code and typed the correctly-spelled `DEFAULT_ADMIN_DOCTOR` would
    // silently still get `undefined`. Left unset, any guest booking that doesn't pick a
    // doctor gets `requestedDoctorId = undefined`, which used to reach
    // `tx.doctor.findUnique({ where: { id: undefined } })` — a Prisma validation
    // exception, not the clean 404 the code around it clearly intends (see
    // appointment.service.ts's now-added explicit guard). Accepts the correct spelling
    // first, falls back to the legacy typo'd name so an existing deployment that's
    // already set the misspelled var doesn't silently break.
    defaultAdminDoctor: process.env.DEFAULT_ADMIN_DOCTOR ?? process.env.DEFULT_ADMIN_DOCTOR,
    clientUrl: clientUrl,
    jwt: {
        secret: process.env.JWT_SCRET,
        JWT_EXPIRES_IN: process.env.JWT_EXPIRED_IN,
        refresh_secret:
            process.env.JWT_REFRESH_SECRET ?? process.env.JWT_REFRESH_SCRET,
    },
    cloudinary: {
        name: process.env.CLOUND_NAME,
        key: process.env.API_KEY,
        secret: process.env.API_SECRET
    },
    emailPass: process.env.EMAIL_PASS,
    adminEmail: process.env.ADMIN_EMAIL,
    gmail_app_Email: process.env.GMAIL_APP_EMAIL,
    backendLiveUrl: process.env.BACKEND_LIVE_URL,
    backendLocalUrl: process.env.BACKEND_LOCAL_URL,
    // Pass 7 — Payment System. Two regional gateways: Razorpay for INR (India),
    // Telr for KWD (Kuwait). Selected per-doctor via Doctor.currency — see
    // docs/passes/07-payment-system.md.
    razorpay: {
        keyId: process.env.RAZORPAY_KEY_ID,
        keySecret: process.env.RAZORPAY_KEY_SECRET,
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    },
    telr: {
        storeId: process.env.TELR_STORE_ID,
        authKey: process.env.TELR_AUTH_KEY,
        testMode: process.env.TELR_TEST_MODE === 'true',
    },
    // Base origin only (no path) — used to build payment gateway return/webhook URLs,
    // e.g. `${backendOrigin}/api/v1/payment/telr/return`. Deliberately separate from
    // backendLiveUrl/backendLocalUrl above, which already have `/api/v1/auth/` baked in
    // for the email-link use case and would need fragile string surgery to reuse here.
    backendOrigin: process.env.NODE_ENV === 'development' ? process.env.BACKEND_ORIGIN_LOCAL : process.env.BACKEND_ORIGIN,
    // Pass 9 — Cancellation & Rescheduling. These are reasonable defaults, not a
    // researched business policy — confirm/adjust with whoever owns pricing/policy
    // decisions before relying on them in production. Kept configurable via env vars
    // specifically so that adjustment doesn't require a code change.
    cancellation: {
        // Cancelling this many hours or more before the scheduled time is "on-time";
        // less than this is "late." See docs/passes/09-cancellation-rescheduling.md.
        cutoffHours: process.env.CANCELLATION_CUTOFF_HOURS ? Number(process.env.CANCELLATION_CUTOFF_HOURS) : 24,
        onTimeRefundPercent: process.env.CANCELLATION_ON_TIME_REFUND_PERCENT ? Number(process.env.CANCELLATION_ON_TIME_REFUND_PERCENT) : 100,
        lateRefundPercent: process.env.CANCELLATION_LATE_REFUND_PERCENT ? Number(process.env.CANCELLATION_LATE_REFUND_PERCENT) : 50,
    },
}