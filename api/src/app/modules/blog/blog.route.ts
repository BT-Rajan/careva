import express, { NextFunction, Request, Response } from 'express';
import { auth } from '../../middlewares/auth';
import { AuthUser } from '../../../enums';
import { BlogController } from './blog.controller';
import { CloudinaryHelper } from '../../../helpers/uploadHelper';

const router = express.Router();
router.post('/',
    auth(AuthUser.DOCTOR),
    CloudinaryHelper.upload.single('file'),
    (req: Request, res: Response, next: NextFunction) => {
        return BlogController.createBlog(req, res, next);
    });
router.get('/', BlogController.getAllBlogs);
router.get('/:id', BlogController.getBlog);
// Pass 4 BUG FIX (historical): AuthUser.SUPER_ADMIN wasn't a real role at the time — the
// Prisma UserRole enum only had admin | patient | doctor, so no Auth row could ever have
// role='super_admin'. That branch could never match a real user, meaning admins had no
// path to delete blog content at all. Replaced with the real AuthUser.ADMIN back then.
// Pass 27/28 made super_admin a real role (a platform-operator role, cross-clinic by
// design) — re-added below alongside ADMIN, now that it actually means something.
router.delete('/:id', auth(AuthUser.DOCTOR, AuthUser.ADMIN, AuthUser.SUPER_ADMIN), BlogController.deleteBlog);
router.patch('/:id',
    CloudinaryHelper.upload.single('file'),
    auth(AuthUser.DOCTOR, AuthUser.ADMIN, AuthUser.SUPER_ADMIN),
    (req: Request, res: Response, next: NextFunction) => {
        return BlogController.updateBlog(req, res, next);
    }
)

export const BlogRoutes = router;