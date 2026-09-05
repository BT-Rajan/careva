import prisma from "../../../shared/prisma";
import ApiError from "../../../errors/apiError";
import httpStatus from "http-status";
import { Blogs } from "@prisma/client";
import { IBlogFilters, blogSearchablFields } from "./blog.interface";
import calculatePagination, { IOption } from "../../../shared/paginationHelper";
import { IGenericResponse } from "../../../interfaces/common";
import { Request } from "express";
import { IUpload } from "../../../interfaces/file";
import { CloudinaryHelper } from "../../../helpers/uploadHelper";

const createBlog = async (req: Request): Promise<Blogs> => {
    const user = req.user as any;
    const file = req.file as IUpload;
    const data = JSON.parse(req.body.data);

    const isUserExist = await prisma.doctor.findUnique({
        where: {
            id: user.userId
        }
    })
    if (!isUserExist) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Doctor Account is not found !!')
    }
    if (isUserExist) {
        data.userId = isUserExist.id
    }
    if (file) {
        const uploadImage = await CloudinaryHelper.uploadFile(file);
        if (uploadImage) {
            data.img = uploadImage.secure_url;
        } else {
            throw new ApiError(httpStatus.EXPECTATION_FAILED, 'Failed to Updated Image');
        }
    }
    return await prisma.blogs.create({ data });
}

const getAllBlogs = async (filters: IBlogFilters, options: IOption): Promise<IGenericResponse<Blogs[]>> => {
    const { limit, page, skip } = calculatePagination(options);
    const { searchTerm, ...filterData } = filters;

    const andConditions = [];
    if (searchTerm) {
        andConditions.push({
            OR: blogSearchablFields.map((field) => ({
                [field]: {
                    contains: searchTerm
                }
            }))
        })
    };
    if (Object.keys(filterData).length > 0) {
        andConditions.push({
            AND: Object.entries(filterData).map(([key, value]) => ({
                [key]: { equals: value }
            }))
        });
    }
    const whereConditions = andConditions.length > 0 ? { AND: andConditions } : {};

    const result = await prisma.blogs.findMany({
        skip,
        take: limit,
        where: whereConditions,
        include: {
            user: {
                select: {
                    firstName: true,
                    lastName: true,
                    designation: true
                }
            }
        },
        orderBy: options.sortBy && options.sortOrder ? {
            [options.sortBy]: options.sortOrder
        } : {
            createdAt: 'desc'
        }
    })
    const total = await prisma.blogs.count({ where: whereConditions });

    return {
        meta: {
            page,
            limit,
            total
        },
        data: result
    }
}

const getBlog = async (id: string): Promise<Blogs | null> => {
    const result = await prisma.blogs.findUnique({
        where: { id },
        include: {
            user: {
                select: {
                    firstName: true,
                    lastName: true,
                    designation: true
                }
            }
        }
    });
    return result;
}

const deleteBlog = async (reqUser: any, id: string): Promise<Blogs | null> => {
    // Pass 4: previously no ownership check — any doctor could delete any other
    // doctor's blog post.
    const existing = await prisma.blogs.findUnique({ where: { id } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Blog is not found !!');
    }
    const isAdmin = reqUser?.role === 'admin';
    if (!isAdmin && existing.userId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to delete this blog !!');
    }
    const result = await prisma.blogs.delete({
        where: { id }
    });
    return result;
}

const BLOG_PROTECTED_FIELDS = ['id', 'userId', 'createdAt', 'updatedAt'];

const updateBlog = async (req: Request): Promise<Blogs | null> => {
    const file = req.file as IUpload;
    const id = req.params.id as string;
    const blogData = JSON.parse(req.body.data);
    const reqUser: any = req.user;
    const isAdmin = reqUser?.role === 'admin';

    // Pass 4: previously no ownership check — any doctor could update any other
    // doctor's blog post. Also strips userId/id/timestamps from mass-assignment.
    const existing = await prisma.blogs.findUnique({ where: { id } });
    if (!existing) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Blog is not found !!');
    }
    if (!isAdmin && existing.userId !== reqUser?.userId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You are not allowed to update this blog !!');
    }
    for (const field of BLOG_PROTECTED_FIELDS) {
        delete blogData[field];
    }
    if (file) {
        const uploadImage = await CloudinaryHelper.uploadFile(file);
        if (uploadImage) {
            blogData.img = uploadImage.secure_url;
        } else {
            throw new ApiError(httpStatus.EXPECTATION_FAILED, 'Failed to Updated Image');
        }
    }
    const result = await prisma.blogs.update({
        where: { id },
        data: blogData
    });
    return result;
}

export const BlogService = {
    createBlog,
    getAllBlogs,
    getBlog,
    deleteBlog,
    updateBlog
}