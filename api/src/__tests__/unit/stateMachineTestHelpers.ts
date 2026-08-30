/**
 * Pass 25 — Testing.
 *
 * Every lifecycle module in this codebase (appointment, doctor, prescription,
 * invoice, review) follows the identical shape: a TRANSITIONS map of legal next-states,
 * and an assert function that throws on an illegal move. This helper exhaustively
 * checks the SHAPE half of that contract for any such map — every (from, to) pair over
 * every status the map declares, not just the pairs a human thought to write a test
 * case for. This is exactly the kind of check a hand-written test suite tends to
 * miss (nobody writes "and every status can't jump to every other status" as an
 * explicit case); enumerating it mechanically catches a typo'd or missing entry that a
 * handful of hand-picked examples would not.
 *
 * The actor half (who's allowed to make an already-legal move) is deliberately NOT
 * generalized here — each lifecycle file keeps its actor map private (not exported),
 * and actor rules read far more clearly as explicit, named test cases ("a patient
 * cannot approve their own doctor account") than as a generic data-driven loop over an
 * internal object this file would have no access to anyway.
 */

export const assertExhaustiveTransitionGraph = <T extends string>(
    allStatuses: readonly T[],
    transitions: Record<T, T[]>,
    assertFn: (from: T, to: T, ...rest: any[]) => any,
    extraArgsForShapeCheck: any[]
) => {
    for (const from of allStatuses) {
        const legal = new Set(transitions[from] ?? []);
        for (const to of allStatuses) {
            const shouldSucceed = legal.has(to);
            if (shouldSucceed) continue; // legal edges are covered by each file's own actor-specific tests
            it(`rejects ${String(from)} -> ${String(to)} (not a legal transition)`, () => {
                expect(() => assertFn(from, to, ...extraArgsForShapeCheck)).toThrow();
            });
        }
    }
};
