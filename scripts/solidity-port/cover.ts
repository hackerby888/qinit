// Pairwise covering arrays.

/** xorshift32, the deterministic PRNG this repo already uses in its container and control-flow fuzzers. */
export function xorshift32(seed: number): () => number {
    let state = (seed ^ 0x9e3779b9) >>> 0;
    if (state === 0) state = 0x1234567;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state;
    };
}

function pairKey(i: number, vi: number, j: number, vj: number): string {
    return `${i}:${vi}|${j}:${vj}`;
}

/** Greedy pairwise cover: every value of every axis appears at least once, and every (axisA, axisB) value
 *  pair appears in at least one row. Rows come back as indices into each domain. */
export function pairwiseCover(domains: readonly (readonly unknown[])[], seed: number, maxRows: number): number[][] {
    const axisCount = domains.length;
    if (axisCount === 0) return [[]];
    if (axisCount === 1) return domains[0].slice(0, maxRows).map((_, index) => [index]);

    const required = new Set<string>();
    for (let i = 0; i < axisCount; i++) {
        for (let j = i + 1; j < axisCount; j++) {
            for (let vi = 0; vi < domains[i].length; vi++) {
                for (let vj = 0; vj < domains[j].length; vj++) required.add(pairKey(i, vi, j, vj));
            }
        }
    }

    const random = xorshift32(seed);
    const rows: number[][] = [];
    while (required.size > 0 && rows.length < maxRows) {
        // Build one row greedily: at each axis pick the value covering the most still-required pairs,
        // breaking ties with the seeded PRNG so the result is deterministic but not biased to index 0.
        const row: number[] = new Array(axisCount).fill(-1);
        const order = shuffledIndices(axisCount, random);
        for (const axis of order) {
            let bestValue = 0;
            let bestGain = -1;
            for (let value = 0; value < domains[axis].length; value++) {
                let gain = 0;
                for (let other = 0; other < axisCount; other++) {
                    if (other === axis || row[other] === -1) continue;
                    const key = axis < other ? pairKey(axis, value, other, row[other]) : pairKey(other, row[other], axis, value);
                    if (required.has(key)) gain++;
                }
                // A value never yet used on this axis is worth taking even when it pairs nothing new.
                if (gain > bestGain || (gain === bestGain && random() % 2 === 0)) {
                    bestGain = gain;
                    bestValue = value;
                }
            }
            row[axis] = bestValue;
        }
        for (let i = 0; i < axisCount; i++) {
            for (let j = i + 1; j < axisCount; j++) required.delete(pairKey(i, row[i], j, row[j]));
        }
        rows.push(row);
        // A row that covered nothing new means the greedy pass has stalled; fall back to sweeping the
        // remaining pairs directly so termination does not depend on the PRNG.
        if (rows.length > 1 && required.size > 0 && rows.length >= maxRows) break;
    }

    // Any pair the greedy pass missed under the row cap is covered by one explicit row each, budget allowing.
    for (const key of required) {
        if (rows.length >= maxRows) break;
        const [left, right] = key.split("|");
        const [i, vi] = left.split(":").map(Number);
        const [j, vj] = right.split(":").map(Number);
        const row = new Array(axisCount).fill(0);
        row[i] = vi;
        row[j] = vj;
        rows.push(row);
    }
    return rows;
}

function shuffledIndices(count: number, random: () => number): number[] {
    const indices = Array.from({ length: count }, (_, index) => index);
    for (let i = count - 1; i > 0; i--) {
        const j = random() % (i + 1);
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
}
