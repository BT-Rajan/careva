import express from 'express';
import { AuthController } from './auth.controller';
import { auth } from '../../middlewares/auth';
import { loginRateLimiter, passwordResetRateLimiter, verifyEmailRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post('/login', loginRateLimiter, AuthController.Login);
router.post('/logout', AuthController.Logout);
router.post('/change-password', auth(), AuthController.ChangePassword);
router.post('/reset-password', passwordResetRateLimiter, AuthController.resetPassword);
router.post('/reset-password/confirm', passwordResetRateLimiter, AuthController.PasswordResetConfirm);
router.get('/user/verify/:userId/:uniqueString', verifyEmailRateLimiter, AuthController.VerifyUser);
router.get('/verified', AuthController.Verified);
router.get('/expired/link', AuthController.VerficationExpired);

export const AuthRouter = router;