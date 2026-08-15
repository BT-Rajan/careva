export const appointStatusDsc = {
    payment: 'Payment Status: Set to "paid" to represent a payment that is completed',
    appointment: {
        PENDING: 'Your request has been sent to the doctor and is awaiting a response.',
        SCHEDULED: 'The doctor has accepted your appointment — see you then!',
        DECLINED: 'The doctor was unable to accept this appointment request.',
        EXPIRED: 'This request was not actioned in time and has expired.',
        COMPLETED: 'This appointment has been completed.',
        CANCELLED_BY_PATIENT: 'This appointment was cancelled by the patient.',
        CANCELLED_BY_DOCTOR: 'This appointment was cancelled by the doctor.',
        CANCELLED_BY_ADMIN: 'This appointment was cancelled by an administrator.',
        NO_SHOW: 'The patient did not attend this scheduled appointment.',
    },
    followUpDate: 'Represent a different follow-up date.',
    prescriptionStatus: {
        issued: "Set to 'issued' to represent that a prescription has been issued.",
        notIssued: "Set to 'not_issued' to represent that a prescription has not been issued yet."
    }
}