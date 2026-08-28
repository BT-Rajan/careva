/* eslint-disable no-undef */
import path from 'path';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
const { combine, timestamp, label, printf } = format;

//Customm Log Format

const myFormat = printf(({ level, message, label, timestamp }) => {
  const date = new Date(timestamp as string | number | Date);
  const hour = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  return `${date.toDateString()} ${hour}:${minutes}:${seconds} } [${label}] ${level}: ${message}`;
});

// Pass 22 — Audit & Observability BUG FIX: this whole file — logger, errorlogger, the
// daily-rotate-file setup, even the "PH" label below — was fully configured but never
// actually imported anywhere else in the codebase. Every log line in this app, from
// `server.ts`'s crash handler to every service function's `console.error`, was going
// to ephemeral stdout only: nothing persisted once a process restarted or a terminal
// scrolled away. "PH" (now "Careva") is a leftover label from whatever starter
// template this project began from — the same class of dead, uncustomized boilerplate
// Pass 17 found in the two Mongoose-era error handlers.
const logger = createLogger({
  level: 'info',
  format: combine(label({ label: 'Careva' }), timestamp(), myFormat),
  transports: [
    new transports.Console(),
    new DailyRotateFile({
      filename: path.join(
        process.cwd(),
        'logs',
        'winston',
        'successes',
        'careva-%DATE%-success.log'
      ),
      datePattern: 'YYYY-DD-MM-HH',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    }),
  ],
});

const errorlogger = createLogger({
  level: 'error',
  format: combine(label({ label: 'Careva' }), timestamp(), myFormat),
  transports: [
    new transports.Console(),
    new DailyRotateFile({
      filename: path.join(
        process.cwd(),
        'logs',
        'winston',
        'errors',
        'careva-%DATE%-error.log'
      ),
      datePattern: 'YYYY-DD-MM-HH',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    }),
  ],
});

export { logger, errorlogger };