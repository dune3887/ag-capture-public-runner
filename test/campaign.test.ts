import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildWorkerMatrix,
    normalizeRunId,
    splitQuota,
    stagingCollectionName,
    validateStagingCounts,
} from '../scripts/campaign';

test('quota split is exact for 299990 rows across 50 workers', () => {
    const quotas = splitQuota(299_990, 50);
    assert.equal(quotas.length, 50);
    assert.deepEqual(quotas.slice(0, 3), [6000, 6000, 6000]);
    assert.deepEqual(quotas.slice(-3), [5999, 5999, 5999]);
    assert.equal(quotas.reduce((sum, value) => sum + value, 0), 299_990);
});

test('worker matrix preserves the exact target', () => {
    const matrix = buildWorkerMatrix(10, 300_000, 50);
    assert.equal(matrix.include.length, 50);
    assert.equal(matrix.include.reduce((sum, entry) => sum + entry.quota, 10), 300_000);
});

test('staging names are deterministic and reject unsafe run ids', () => {
    assert.equal(
        stagingCollectionName('ag_MoMummyMightyPyramid', '12345', 7, 'worker'),
        'simulate_gh_ag_MoMummyMightyPyramid_12345_worker_7',
    );
    assert.equal(
        stagingCollectionName('ag_MoMummyMightyPyramid', '12345', 2, 'canary'),
        'simulate_gh_ag_MoMummyMightyPyramid_12345_canary_2',
    );
    assert.equal(normalizeRunId('12345-1'), '12345-1');
    assert.equal(normalizeRunId('ag_MoMummy-20260909'), 'ag_MoMummy-20260909');
    assert.throws(() => normalizeRunId('../bad'), /invalid campaign run id/);
    assert.throws(
        () => stagingCollectionName('other_game', '12345', 1, 'worker'),
        /invalid AG database name/,
    );
});

test('matrix rejects a target below the current valid count', () => {
    assert.throws(() => buildWorkerMatrix(300_001, 300_000, 50), /below existing/);
});

test('staging permits only bounded valid overage from concurrent sessions', () => {
    assert.equal(validateStagingCounts(6007, 6007, 6000, 7), 7);
    assert.throws(() => validateStagingCounts(6008, 6008, 6000, 7), /allowedOverage/);
    assert.throws(() => validateStagingCounts(6000, 5999, 6000, 7), /invalid documents/);
    assert.throws(() => validateStagingCounts(5999, 5999, 6000, 7), /allowedOverage/);
});
