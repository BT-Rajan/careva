import { ReviewStatus } from '@prisma/client';
import { TRANSITIONS, assertValidReviewTransition } from '../../app/modules/reviews/review-lifecycle';
import { assertExhaustiveTransitionGraph } from './stateMachineTestHelpers';

const ALL_STATUSES: ReviewStatus[] = ['SUBMITTED', 'PUBLISHED', 'FLAGGED', 'REMOVED'];

describe('review-lifecycle', () => {
    describe('every transition is admin-only — no patient/doctor edge exists in this graph', () => {
        it('admin can publish a SUBMITTED review', () => {
            expect(() => assertValidReviewTransition('SUBMITTED', 'PUBLISHED', 'admin')).not.toThrow();
        });
        it('admin can remove a SUBMITTED review outright', () => {
            expect(() => assertValidReviewTransition('SUBMITTED', 'REMOVED', 'admin')).not.toThrow();
        });
        it('admin can flag a PUBLISHED review', () => {
            expect(() => assertValidReviewTransition('PUBLISHED', 'FLAGGED', 'admin')).not.toThrow();
        });
        it('admin can remove a PUBLISHED review', () => {
            expect(() => assertValidReviewTransition('PUBLISHED', 'REMOVED', 'admin')).not.toThrow();
        });
        it('admin can clear a flag, restoring to PUBLISHED', () => {
            expect(() => assertValidReviewTransition('FLAGGED', 'PUBLISHED', 'admin')).not.toThrow();
        });
        it('admin can remove a FLAGGED review', () => {
            expect(() => assertValidReviewTransition('FLAGGED', 'REMOVED', 'admin')).not.toThrow();
        });
        it('admin can restore a REMOVED review — unlike Invoice/Prescription, this is not fully terminal', () => {
            expect(() => assertValidReviewTransition('REMOVED', 'PUBLISHED', 'admin')).not.toThrow();
        });
    });

    describe('REMOVED is the only status with any legal way back', () => {
        it('REMOVED -> PUBLISHED is the sole legal outgoing edge from REMOVED', () => {
            expect(TRANSITIONS.REMOVED).toEqual(['PUBLISHED']);
        });
    });

    assertExhaustiveTransitionGraph(ALL_STATUSES, TRANSITIONS, assertValidReviewTransition, ['admin']);
});
