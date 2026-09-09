import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyGameShard,
    buildCaptureState,
    selectNextTask,
    markTaskSuccess,
} from '../src/ag.plan';
import { AGGameConfig, AGMongoCounts } from '../src/ag.types';

function game(gameId: string, dbName = gameId): AGGameConfig {
    return { gameId, name: gameId, dbName, backendId: `backend-${gameId}` };
}

test('applyGameShard splits games deterministically with one-based shard indexes', () => {
    const games = [game('g1'), game('g2'), game('g3'), game('g4'), game('g5')];

    assert.deepEqual(applyGameShard(games, 1, 2).map((item) => item.gameId), ['g1', 'g3', 'g5']);
    assert.deepEqual(applyGameShard(games, 2, 2).map((item) => item.gameId), ['g2', 'g4']);
});

test('buildCaptureState creates base and free-choice option targets from existing counts', () => {
    const counts: AGMongoCounts = {
        base: 3,
        total: 6,
        optionCount: 3,
        freeChoiceOptions: { 1: 1, 2: 2 },
    };

    const state = buildCaptureState(counts, { spinLimit: 5, freeChoicePerOption: 2 });

    assert.equal(state.totalCurrent, 6);
    assert.equal(state.totalTarget, 11);
    assert.equal(state.totalMissing, 5);
    assert.deepEqual(
        state.tasks.map((task) => ({
            key: task.key,
            target: task.target,
            current: task.current,
            missing: task.missing,
        })),
        [
            { key: 'base', target: 5, current: 3, missing: 2 },
            { key: 'choice:1', target: 2, current: 1, missing: 1 },
            { key: 'choice:2', target: 2, current: 2, missing: 0 },
            { key: 'choice:3', target: 2, current: 0, missing: 2 },
        ],
    );
});

test('selectNextTask accounts for in-flight work before choosing the least complete task', () => {
    const state = buildCaptureState(
        { base: 0, total: 0, optionCount: 2, freeChoiceOptions: { 1: 0, 2: 0 } },
        { spinLimit: 1, freeChoicePerOption: 1 },
    );

    const first = selectNextTask(state);
    const second = selectNextTask(state);
    assert.equal(first?.key, 'base');
    assert.equal(second?.key, 'choice:1');

    markTaskSuccess(state, first!);
    const third = selectNextTask(state);
    assert.equal(third?.key, 'choice:2');
});

test('overall and choice quotas can share one stored round without losing progress', () => {
    const state = buildCaptureState(
        { base: 10, total: 10, optionCount: 2, freeChoiceOptions: { 1: 2, 2: 3 } },
        { spinLimit: 10, freeChoicePerOption: 5 },
    );

    assert.equal(state.totalCurrent, 15);
    assert.equal(state.totalTarget, 20);
    assert.equal(state.totalMissing, 5);
});
