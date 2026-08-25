import { tagTypes } from "../tag-types";
import { baseApi } from "./baseApi"

const APPOINTMENT_URL = '/appointment'

export const appointmentApi = baseApi.injectEndpoints({
    endpoints: (build) => ({
        createAppointment: build.mutation({
            query: ({ data, idempotencyKey } = {}) => ({
                url: `${APPOINTMENT_URL}/create`,
                method: 'POST',
                data: data,
                headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined
            }),
            invalidatesTags: [tagTypes.appointments]
        }),
        createAppointmentByUnauthenticateUser: build.mutation({
            query: ({ data, idempotencyKey } = {}) => ({
                url: `${APPOINTMENT_URL}/create-un-authenticate`,
                method: 'POST',
                data: data,
                headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined
            }),
            invalidatesTags: [tagTypes.appointments]
        }),
        trackAppointment: build.mutation({
            query: (data) => ({
                url: `${APPOINTMENT_URL}/tracking`,
                method: 'POST',
                data: data
            })
        }),
        // Pass 15 — Tracking & Public Access. Same underlying endpoint as
        // trackAppointment above, exposed as a query instead of a mutation so
        // BookingSuccess.jsx can auto-fetch on mount (a query hook fetches automatically
        // given an argument; a mutation hook only fires when explicitly called) —
        // TrackAppointment.jsx's manual "paste and click Track" flow keeps using the
        // mutation, which is the right shape for a user-triggered one-off lookup.
        getAppointmentByTracking: build.query({
            query: (trackingId) => ({
                url: `${APPOINTMENT_URL}/tracking`,
                method: 'POST',
                data: { id: trackingId }
            })
        }),
        updateAppointment: build.mutation({
            query: ({ id, data }) => ({
                url: `${APPOINTMENT_URL}/${id}`,
                method: 'PATCH',
                data: data
            }),
            invalidatesTags: [tagTypes.appointments]
        }),
        // Pass 9 — Cancellation & Rescheduling. Dedicated endpoints so cancellation
        // always goes through refund-eligibility logic — see appointment.service.ts.
        cancelAppointment: build.mutation({
            query: ({ id, reason }) => ({
                url: `${APPOINTMENT_URL}/${id}/cancel`,
                method: 'POST',
                data: { reason }
            }),
            invalidatesTags: [tagTypes.appointments]
        }),
        rescheduleAppointment: build.mutation({
            query: ({ id, scheduleDate, scheduleTime, reason }) => ({
                url: `${APPOINTMENT_URL}/${id}/reschedule`,
                method: 'POST',
                data: { scheduleDate, scheduleTime, reason }
            }),
            invalidatesTags: [tagTypes.appointments]
        }),
        getPatientAppointments: build.query({
            query: () => ({
                url: `${APPOINTMENT_URL}/patient/appointments`,
                method: 'GET'
            }),
            providesTags: [tagTypes.appointments]
        }),
        getSingleAppointment: build.query({
            query: (id) => ({
                url: `${APPOINTMENT_URL}/${id}`,
                method: 'GET'
            }),
            providesTags: [tagTypes.appointments]
        }),
        // Pass 14: getAppointmentedPaymentInfo / getPatientInvoices / getDoctorInvoices
        // removed from here — they rendered a raw Payment row labeled as an "invoice"
        // (Gap G7, docs/passes/01-domain-state-model.md). Use invoiceApi.js's
        // useGetInvoiceByAppointmentQuery / useGetPatientInvoicesQuery /
        // useGetDoctorInvoicesQuery instead, backed by the real Invoice entity.
        getDoctorAppointments: build.query({
            query: (arg) => ({
                url: `${APPOINTMENT_URL}/doctor/appointments`,
                method: 'GET',
                params: arg
            }),
            providesTags: [tagTypes.appointments]
        }),
        getDoctorPatients: build.query({
            query: () => ({
                url: `${APPOINTMENT_URL}/doctor/patients`,
                method: 'GET'
            }),
            providesTags: [tagTypes.appointments]
        }),
    })
})

export const { 
    useGetDoctorAppointmentsQuery,
    useGetPatientAppointmentsQuery,
    useGetDoctorPatientsQuery,
    useCreateAppointmentMutation,
    useGetSingleAppointmentQuery,
    useUpdateAppointmentMutation,
    useCancelAppointmentMutation,
    useRescheduleAppointmentMutation,
    useCreateAppointmentByUnauthenticateUserMutation, 
    useTrackAppointmentMutation,
    useGetAppointmentByTrackingQuery
} = appointmentApi;