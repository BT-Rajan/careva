import { baseApi } from "./baseApi"

// Pass 30 — Multi-Tenant Clinics (frontend wiring). Public, read-only — matches
// clinic.route.ts's api/src/app/modules/clinic module, which was itself a gap found
// while starting this pass: Passes 27-29 built the whole Clinic data model but never
// an API to list them, so no frontend form (signup, booking, blog creation) had any
// way to let someone pick a clinic. This is the minimal client-side counterpart.
const CLINIC_URL = '/clinic'

export const clinicApi = baseApi.injectEndpoints({
    endpoints: (build) => ({
        getAllClinics: build.query({
            query: () => ({
                url: `${CLINIC_URL}`,
                method: 'GET',
            }),
        }),
        getClinicBySlug: build.query({
            query: (slug) => ({
                url: `${CLINIC_URL}/${slug}`,
                method: 'GET',
            }),
        }),
    })
})

export const {
    useGetAllClinicsQuery,
    useGetClinicBySlugQuery,
} = clinicApi
