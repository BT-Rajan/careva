import express from 'express';
import { AuthController } from './auth.controller';
import { auth } from '../../middlewares/auth';
import { loginRateLimiter, passwordResetRateLimiter, verifyEmailRateLimiter } from '../../middlewares/rateLimiter';
import validateRequest from '../../middlewares/validateRequest';
import { AuthValidation } from './auth.validation';

const router = express.Router();

router.post('/login', loginRateLimiter, validateRequest(AuthValidation.LoginValidation), AuthController.Login);
router.post('/logout', AuthController.Logout);
router.post('/change-password', auth(), validateRequest(AuthValidation.ChangePasswordValidation), AuthController.ChangePassword);
router.post('/reset-password', passwordResetRateLimiter, validateRequest(AuthValidation.ResetPasswordValidation), AuthController.resetPassword);
router.post('/reset-password/confirm', passwordResetRateLimiter, validateRequest(AuthValidation.ResetPasswordConfirmValidation), AuthController.PasswordResetConfirm);
router.get('/user/verify/:userId/:uniqueString', verifyEmailRateLimiter, AuthController.VerifyUser);
router.get('/verified', AuthController.Verified);
router.get('/expired/link', AuthController.VerficationExpired);

export const AuthRouter = router;