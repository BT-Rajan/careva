import { v2 as cloudinary } from 'cloudinary'
import config from '../config';
import multer from 'multer';
import { ICloudinaryResponse } from '../interfaces/file';
import ApiError from '../errors/apiError';
import httpStatus from 'http-status';

cloudinary.config({
    cloud_name: config.cloudinary.name,
    api_key: config.cloudinary.key,
    api_secret: config.cloudinary.secret
});

// Adversarial stress-test finding (post Pass 26). `multer.memoryStorage()` buffers the
// entire file in process memory before Cloudinary ever sees it. With no `limits` and no
// `fileFilter`, every one of this app's four upload endpoints (doctor/patient profile
// photo, blog cover, blog inline image) accepted a file of any size and any type:
// - Unbounded size = an unauthenticated-adjacent memory-exhaustion DoS — a handful of
//   concurrent large-file POSTs can push the Node process to its memory limit and crash
//   it, taking every other request down with it.
// - No mimetype check + `resource_type: 'auto'` on the Cloudinary side below = an
//   attacker (or just a confused patient) can upload an arbitrary file — video, archive,
//   executable — through what the UI presents as an "image" field.
// 8MB is a generous ceiling for a profile photo or blog cover; raise it if a real usage
// pattern needs more, but it should never be unbounded.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
        if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
            return cb(new ApiError(httpStatus.BAD_REQUEST, 'Only JPEG, PNG, WEBP, or GIF images are allowed.'));
        }
        cb(null, true);
    },
});

// Pass 18 — Error Handling & Recovery. Previously threw a plain `Error` for the
// no-file case, and let a Cloudinary failure (network error, invalid credentials,
// quota exceeded) reject with whatever raw shape Cloudinary's SDK returns — neither is
// an ApiError, so both fell into app.ts's generic fallback branch: a real client
// mistake (no file sent) and a genuine third-party outage were both reported back as
// an indistinguishable, unhelpful 500. Distinguishing them here means the four callers
// (doctor/patient/blog profile-image and blog-cover uploads) don't each need their own
// try/catch to get a sensible response — none of them had one before this pass.
const uploadFile = async (file: any): Promise<ICloudinaryResponse> => {
    if (!file || !file.buffer) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'No file was provided to upload.');
    }
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            { resource_type: 'image', folder: 'careva' },
            (error: any, result: any) => {
                if (error) {
                    console.error('Cloudinary upload failed:', error);
                    reject(new ApiError(httpStatus.BAD_GATEWAY, 'Image upload service is currently unavailable. Please try again in a moment.'));
                } else {
                    resolve(result)
                }
            }
        ).end(file.buffer);
    })
};

export const CloudinaryHelper = {
    uploadFile,
    upload
}