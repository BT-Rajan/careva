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

const upload = multer({storage: multer.memoryStorage()});

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
            { resource_type: 'auto', folder: 'careva' },
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