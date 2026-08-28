import { tagTypes } from "../tag-types";
import { baseApi } from "./baseApi"

const REVIEW_URL = '/review'

export const reviewApi = baseApi.injectEndpoints({
    endpoints: (build) => ({
        getAllReviews: build.query({
            query: (args) => ({
                url: `${REVIEW_URL}`,
                method: 'GET',
                params: args
            }),
            providesTags: [tagTypes.reviews]
        }),
        // Pass 21 — Admin & Operational Controls. The public getAllReviews above is now
        // filtered server-side to PUBLISHED-only (review moderation) — this is the
        // admin moderation queue, seeing every status.
        getAllReviewsForAdmin: build.query({
            query: (args) => ({
                url: `${REVIEW_URL}/admin/all`,
                method: 'GET',
                params: args
            }),
            providesTags: [tagTypes.reviews]
        }),
        getSingleReview: build.query({
            query: (id) => ({
                url: `${REVIEW_URL}/${id}`,
                method: 'GET'
            }),
            providesTags: [tagTypes.reviews]
        }),
        getDoctorReviews: build.query({
            query: (id) => ({
                url: `${REVIEW_URL}/doctor-review/${id}`,
                method: 'GET'
            }),
            providesTags: [tagTypes.reviews]
        }),
        replyReviews: build.mutation({
            query: ({id, data}) => ({
                url: `${REVIEW_URL}/${id}/reply`,
                method: 'PATCH',
                data: data
            }),
            invalidatesTags: [tagTypes.reviews]
        }),
        createReview: build.mutation({
            query: ({ data }) => ({
                url: `${REVIEW_URL}/`,
                method: 'POST',
                data: data
            }),
            invalidatesTags: [tagTypes.reviews]
        }),
        // Pass 21 BUG FIX: these two were `build.query` despite being DELETE/PATCH
        // actions — RTK Query auto-generates a `use...Query` hook for a `build.query`
        // endpoint, which AUTO-FETCHES on mount/param-change. A delete or update that
        // fires itself just because a component happened to render with an id in scope
        // is a serious, dangerous bug — the same misclassification Pass 13 found and
        // fixed for prescriptions. Never actually exercised in production because the
        // one real call site (Admin/Reviews/Reviews.jsx's delete handler) worked around
        // it by never calling the generated hook at all — it was a stub showing a
        // placeholder message instead. Converted to `build.mutation` (the correct,
        // explicitly-triggered shape) and the real handler wired up alongside this fix.
        deleteReview: build.mutation({
            query: (id) => ({
                url: `${REVIEW_URL}/${id}`,
                method: 'DELETE',
            }),
            invalidatesTags: [tagTypes.reviews]
        }),
        updateReview: build.mutation({
            query: ({ id, data }) => ({
                url: `${REVIEW_URL}/${id}`,
                method: 'PATCH',
                data: data
            }),
            invalidatesTags: [tagTypes.reviews]
        }),
        // Pass 21 — the moderation actions themselves.
        publishReview: build.mutation({
            query: ({ id, reason }) => ({
                url: `${REVIEW_URL}/${id}/publish`,
                method: 'PATCH',
                data: { reason }
            }),
            invalidatesTags: [tagTypes.reviews]
        }),
        flagReview: build.mutation({
            query: ({ id, reason }) => ({
                url: `${REVIEW_URL}/${id}/flag`,
                method: 'PATCH',
                data: { reason }
            }),
            invalidatesTags: [tagTypes.reviews]
        }),
        removeReview: build.mutation({
            query: ({ id, reason }) => ({
                url: `${REVIEW_URL}/${id}/remove`,
                method: 'PATCH',
                data: { reason }
            }),
            invalidatesTags: [tagTypes.reviews]
        }),
    })
})

export const {
    useCreateReviewMutation,
    useDeleteReviewMutation,
    useGetAllReviewsQuery,
    useGetAllReviewsForAdminQuery,
    useGetDoctorReviewsQuery,
    useGetSingleReviewQuery,
    useUpdateReviewMutation,
    useReplyReviewsMutation,
    usePublishReviewMutation,
    useFlagReviewMutation,
    useRemoveReviewMutation,
} = reviewApi;