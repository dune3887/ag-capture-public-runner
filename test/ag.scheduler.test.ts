import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptureState, ensureChoiceTasks } from '../src/ag.plan';
import { getCaptureSampleGroups, isDeterministicCaptureError, throwIfSchedulerFailed } from '../src/ag.scheduler';
import { AGCompletedRound } from '../src/ag.types';

function round(optionIndex: number, isFeature: boolean): AGCompletedRound {
    return {
        isFeature,
        optionIndex,
        optionCount: optionIndex > 0 ? 2 : 0,
        bet: 1,
        win: 0,
        data: {},
    };
}

test('feature rounds without a choice still count toward the unbiased overall sample', () => {
    const state = buildCaptureState(
        { base: 0, total: 0, optionCount: 0, freeChoiceOptions: {} },
        { spinLimit: 10, freeChoicePerOption: 2 },
    );

    assert.deepEqual(getCaptureSampleGroups(round(0, true), state), ['base']);
});

test('choice rounds can count once for both overall and option-specific distributions', () => {
    const state = buildCaptureState(
        { base: 0, total: 0, optionCount: 0, freeChoiceOptions: {} },
        { spinLimit: 10, freeChoicePerOption: 2 },
    );
    ensureChoiceTasks(state, 2, 2);

    assert.deepEqual(getCaptureSampleGroups(round(1, true), state), ['base', 'choice:1']);
});

test('choice-only collection continues after the overall sample is complete', () => {
    const state = buildCaptureState(
        { base: 10, total: 10, optionCount: 2, freeChoiceOptions: { 1: 0, 2: 0 } },
        { spinLimit: 10, freeChoicePerOption: 2 },
    );

    assert.deepEqual(getCaptureSampleGroups(round(2, true), state), ['choice:2']);
});

test('protocol failures are deterministic and must not be replaced by a fresh round', () => {
    assert.equal(isDeterministicCaptureError(new Error('unsupported AG nextAction: BONUS_ENTRY')), true);
    assert.equal(isDeterministicCaptureError(new Error('pick: {"type":"MalformedRequest"}')), true);
    assert.equal(isDeterministicCaptureError(new Error('read ETIMEDOUT')), false);
});

test('scheduler propagates incomplete game failures to the process', () => {
    assert.doesNotThrow(() => throwIfSchedulerFailed([]));
    assert.throws(
        () => throwIfSchedulerFailed([new Error('connect refused')]),
        /1 game capture failed.*connect refused/,
    );
});

test('validation resumes missing feature and option quotas independently', () => {
    const state = buildCaptureState(
        { base: 3, total: 7, feature: 3, optionCount: 2, freeChoiceOptions: { 1: 3, 2: 1 } },
        { spinLimit: 3, freeChoicePerOption: 3, featureTarget: 3 },
    );
    assert.deepEqual(getCaptureSampleGroups(round(1, true), state), []);
    assert.deepEqual(getCaptureSampleGroups(round(2, true), state), ['choice:2']);
    assert.equal(state.tasks.find(task => task.key === 'choice:2')?.missing, 2);
});
