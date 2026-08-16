import { tagTypes } from "../tag-types"
import { baseApi } from "./baseApi"

const DOC_URL = '/doctor'

export const doctorApi = baseApi.injectEndpoints({
    endpoints: (build) => ({
        getDoctors: build.query({
            query: (arg) => ({
                url: `${DOC_URL}`,
                method: 'GET',
                params: arg
            }),
            transformResponse: (response) => {
                return {
                    doctors: response?.data || [],
                    meta: response?.meta || {}
                };
            },
            providesTags: [tagTypes.doctor]
        }),
        // Pass 10 — Doctor Lifecycle. The public getDoctors above now only returns
        // APPROVED doctors (see doctor.service.ts) — admin needs to see every approval
        // status for the review queue, hence this separate admin-only endpoint.
        getDoctorsForAdmin: build.query({
            query: (arg) => ({
                url: `${DOC_URL}/admin/all`,
                method: 'GET',
                params: arg
            }),
            transformResponse: (response) => {
                return {
                    doctors: response?.data || [],
                    meta: response?.meta || {}
                };
            },
            providesTags: [tagTypes.doctor]
        }),
        updateDoctorApprovalStatus: build.mutation({
            query: ({ id, status, reason }) => ({
                url: `${DOC_URL}/${id}/approval-status`,
                method: 'PATCH',
                data: { status, reason }
            }),
            invalidatesTags: [tagTypes.doctor]
        }),
        getDoctor: build.query({
            query: (id) => ({
                url: `${DOC_URL}/${id}`,
                method: 'GET',
            }),
            providesTags: [tagTypes.doctor]
        }),
        updateDoctor: build.mutation({
            query: ({ data, id }) => ({
                url: `${DOC_URL}/${id}`,
                method: 'PATCH',
                data: data,
                headers: {
                    'Content-Type': 'multipart/form-data',
                },
            }),
            invalidatesTags: [tagTypes.doctor]
        })
    })
})

export const { useGetDoctorsQuery, useGetDoctorsForAdminQuery, useGetDoctorQuery, useUpdateDoctorMutation, useUpdateDoctorApprovalStatusMutation } = doctorApi