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
// Pass 4 BUG FIX: AuthUser.SUPER_ADMIN isn't a real role — the Prisma UserRole enum only
// has admin | patient | doctor, so no Auth row can ever have role='super_admin'. That
// branch could never match a real user, meaning admins had no path to delete blog
// content at all. Replaced with the real AuthUser.ADMIN, and added it to update too.
router.delete('/:id', auth(AuthUser.DOCTOR, AuthUser.ADMIN), BlogController.deleteBlog);
router.patch('/:id',
    CloudinaryHelper.upload.single('file'),
    auth(AuthUser.DOCTOR, AuthUser.ADMIN),
    (req: Request, res: Response, next: NextFunction) => {
        return BlogController.updateBlog(req, res, next);
    }
)

export const BlogRoutes = router;