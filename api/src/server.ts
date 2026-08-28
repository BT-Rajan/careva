import { Server } from 'http';
import app from "./app";
import config from './config';
import prisma from './shared/prisma';

let server: Server;

// Pass 19 — Security Hardening. Fail fast on a missing/weak JWT secret, rather than
// booting successfully and only discovering the problem the first time someone tries
// to log in (a bare `jwt.sign(payload, undefined, ...)` throws immediately, but only
// on that first request — a deployment could sit "up" and passing basic health checks
// while every single auth-dependent request 500s). A short length check isn't a real
// strength audit, but it catches the most likely accidents: an unset env var, or an
// obviously-placeholder value like "secret" left over from local development.
function assertSecureConfig() {
    const secret = config.jwt.secret;
    if (!secret || String(secret).length < 16) {
        console.error('[startup] JWT_SCRET is missing or too short (must be at least 16 characters). Refusing to start.');
        process.exit(1);
    }
}

async function bootstrap() {
    assertSecureConfig();

    server = app.listen(config.port, () => {
        console.log(`Server running on port ${config.port}`);
    });

    // Pass 18 — Error Handling & Recovery. Every previous exit path here had the same
    // two bugs: it discarded the actual error (both uncaughtException and
    // unhandledRejection handlers took no argument at all — `console.log('Handler
    // Error')` with nothing captured, so a crash left zero diagnostic trace of what
    // happened), and it never called `process.exit()` — `server.close()` only stops
    // accepting new connections; Node doesn't exit on its own until every open handle
    // drains, which isn't guaranteed to happen promptly (or at all, if something is
    // still holding a connection open). A crashed process that never actually exits is
    // worse than one that does: a container orchestrator or process manager (PM2,
    // systemd, Docker) relies on the process actually terminating to know to restart
    // it. This single gracefulShutdown path is now used for both crash cases (exit
    // code 1 — Node's own guidance is that a process must exit after an
    // uncaughtException/unhandledRejection, since its internal state is no longer
    // trustworthy) and clean termination signals (exit code 0), and force-exits after
    // a timeout if a normal shutdown hangs (e.g. a slow client keeping a connection
    // open) rather than blocking a deploy indefinitely.
    const gracefulShutdown = (reason: string, error: unknown, exitCode: number) => {
        console.error(`[shutdown] ${reason}`, error ?? '');

        const forceExitTimer = setTimeout(() => {
            console.error('[shutdown] Graceful shutdown timed out after 10s — forcing exit.');
            process.exit(exitCode);
        }, 10_000);
        // Don't let this timer itself keep the process alive if everything else
        // already drained cleanly before it fires.
        forceExitTimer.unref();

        const finish = async () => {
            try {
                await prisma.$disconnect();
                console.log('[shutdown] Database connection closed.');
            } catch (disconnectError) {
                console.error('[shutdown] Error while disconnecting Prisma:', disconnectError);
            }
            clearTimeout(forceExitTimer);
            process.exit(exitCode);
        };

        if (server) {
            server.close(() => {
                console.log('[shutdown] HTTP server closed.');
                finish();
            });
        } else {
            finish();
        }
    };

    process.on('uncaughtException', (error) => {
        gracefulShutdown('Uncaught exception', error, 1);
    });

    process.on('unhandledRejection', (reason) => {
        gracefulShutdown('Unhandled promise rejection', reason, 1);
    });

    process.on('SIGTERM', () => {
        gracefulShutdown('SIGTERM received', null, 0);
    });

    process.on('SIGINT', () => {
        gracefulShutdown('SIGINT received', null, 0);
    });
}

bootstrap();