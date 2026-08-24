import { tagTypes } from "../tag-types";
import { baseApi } from "./baseApi"

const PRESCRIPTION_URL = '/prescription'

export const prescriptionApi = baseApi.injectEndpoints({
    endpoints: (build) => ({
        getAllPrescriptions: build.query({
            query: () => ({
                url: `${PRESCRIPTION_URL}`,
                method: 'GET'
            }),
            providesTags: [tagTypes.prescription]
        }),
        getPrescription: build.query({
            query: (id) => ({
                url: `${PRESCRIPTION_URL}/${id}`,
                method: 'GET'
            }),
            providesTags: [tagTypes.prescription]
        }),
        createPrescription: build.mutation({
            query: ({ data }) => ({
                url: `${PRESCRIPTION_URL}/create`,
                method: 'POST',
                data: data
            }),
            invalidatesTags: [tagTypes.prescription]
        }),
        deletePrescription: build.mutation({
            // Pass 13 BUG FIX: this previously ignored the `id` argument entirely and
            // always hit `${PRESCRIPTION_URL}/` (no id, trailing slash) — a URL shape
            // the backend's `DELETE /:id` route never matches, so every delete request
            // from Prescription.jsx's confirm button was silently failing (or hitting
            // whatever else happened to match that path). Same class of bug as the
            // Pass 4 route-path typo on the backend side of this same feature.
            query: (id) => ({
                url: `${PRESCRIPTION_URL}/${id}`,
                method: 'DELETE',
            }),
            invalidatesTags: [tagTypes.prescription]
        }),
        // Pass 13: replaces the old generic `updatePrescription` mutation, which was
        // dead code — its hook was exported below as `useUpdatePrescriptionQuery`, a
        // name RTK Query never actually generates for a `build.mutation` endpoint (only
        // `build.query` endpoints get a `use...Query` hook), so it was `undefined`
        // everywhere it would have been imported and no component ever called it. The
        // fields it used to let a caller set (`isFullfilled`/`isArchived`) are gone from
        // the schema in favor of a real `status` lifecycle — these two dedicated
        // mutations replace it.
        fulfillPrescription: build.mutation({
            query: (id) => ({
                url: `${PRESCRIPTION_URL}/${id}/fulfill`,
                method: 'PATCH',
            }),
            invalidatesTags: [tagTypes.prescription]
        }),
        archivePrescription: build.mutation({
            query: (id) => ({
                url: `${PRESCRIPTION_URL}/${id}/archive`,
                method: 'PATCH',
            }),
            invalidatesTags: [tagTypes.prescription]
        }),
        updatePrescriptionAndAppointment: build.mutation({
            query: (data) => ({
                url: `${PRESCRIPTION_URL}/update-prescription-appointment`,
                method: 'PATCH',
                data: data
            }),
            invalidatesTags: [tagTypes.prescription]
        }),
        getDoctorPrescription: build.query({
            query: () => ({
                url: `${PRESCRIPTION_URL}/doctor/prescription`,
                method: 'GET'
            }),
            providesTags: [tagTypes.prescription]
        }),
        getPatientPrescription: build.query({
            query: () => ({
                url: `${PRESCRIPTION_URL}/patient/prescription`,
                method: 'GET'
            }),
            providesTags: [tagTypes.prescription]
        })
    })
})

export const {
    useCreatePrescriptionMutation,
    useGetAllPrescriptionsQuery,
    useGetPrescriptionQuery,
    useDeletePrescriptionMutation,
    useGetDoctorPrescriptionQuery,
    useGetPatientPrescriptionQuery,
    useFulfillPrescriptionMutation,
    useArchivePrescriptionMutation,
    useUpdatePrescriptionAndAppointmentMutation
} = prescriptionApi;