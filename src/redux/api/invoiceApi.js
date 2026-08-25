import { tagTypes } from "../tag-types";
import { baseApi } from "./baseApi"

const INVOICE_URL = '/invoice'

export const invoiceApi = baseApi.injectEndpoints({
    endpoints: (build) => ({
        getDoctorInvoices: build.query({
            query: () => ({
                url: `${INVOICE_URL}/doctor`,
                method: 'GET'
            }),
            providesTags: [tagTypes.invoice]
        }),
        getPatientInvoices: build.query({
            query: () => ({
                url: `${INVOICE_URL}/patient`,
                method: 'GET'
            }),
            providesTags: [tagTypes.invoice]
        }),
        getInvoiceByAppointment: build.query({
            query: (appointmentId) => ({
                url: `${INVOICE_URL}/appointment/${appointmentId}`,
                method: 'GET'
            }),
            providesTags: [tagTypes.invoice]
        }),
        getInvoice: build.query({
            query: (id) => ({
                url: `${INVOICE_URL}/${id}`,
                method: 'GET'
            }),
            providesTags: [tagTypes.invoice]
        }),
        voidInvoice: build.mutation({
            query: ({ id, reason }) => ({
                url: `${INVOICE_URL}/${id}/void`,
                method: 'PATCH',
                data: { reason }
            }),
            invalidatesTags: [tagTypes.invoice]
        }),
        correctInvoice: build.mutation({
            query: ({ id, ...data }) => ({
                url: `${INVOICE_URL}/${id}/correct`,
                method: 'POST',
                data
            }),
            invalidatesTags: [tagTypes.invoice]
        }),
    })
})

export const {
    useGetDoctorInvoicesQuery,
    useGetPatientInvoicesQuery,
    useGetInvoiceByAppointmentQuery,
    useGetInvoiceQuery,
    useVoidInvoiceMutation,
    useCorrectInvoiceMutation,
} = invoiceApi;
