import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    CONCURRENT_GAMES,
    CONCURRENT_PER_GAME,
    FREE_CHOICE_PER_OPTION,
    GAME_LEASE_MS,
    GAME_LEASE_RENEW_MS,
    RETRY_DELAY_MS,
    SESSION_READY_DELAY_MS,
    SESSION_RECYCLE_DELAY_MS,
    SPIN_DELAY_MS,
    SPIN_LIMIT,
    WORKER_START_JITTER_MS,
} from '../config';

test('standalone defaults are safe for an isolated canary', () => {
    assert.equal(SPIN_LIMIT, 10);
    assert.equal(FREE_CHOICE_PER_OPTION, 0);
    assert.equal(CONCURRENT_GAMES, 1);
    assert.equal(CONCURRENT_PER_GAME, 1);
    assert.equal(SPIN_DELAY_MS, 200);
    assert.equal(RETRY_DELAY_MS, 2000);
    assert.equal(SESSION_READY_DELAY_MS, 250);
    assert.equal(SESSION_RECYCLE_DELAY_MS, 1000);
    assert.equal(WORKER_START_JITTER_MS, 0);
});

test('standalone concurrency can be explicitly raised to four per game', () => {
    const result = spawnSync(
        process.execPath,
        [
            '-r',
            'ts-node/register',
            '-e',
            "process.stdout.write(String(require('./config').CONCURRENT_PER_GAME))",
        ],
        {
            cwd: process.cwd(),
            env: { ...process.env, CONCURRENT_PER_GAME: '4' },
            encoding: 'utf8',
        },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '4');
});

test('default game lease expires quickly after abnormal process exit', () => {
    assert.equal(GAME_LEASE_MS, 90000);
    assert.equal(GAME_LEASE_RENEW_MS, 20000);
});

for (const value of ['0', '-2', 'not-a-number']) {
    test(`invalid concurrency ${value} falls back to one worker`, () => {
        const result = spawnSync(process.execPath, [
            '-r', 'ts-node/register', '-e',
            "process.stdout.write(String(require('./config').CONCURRENT_PER_GAME))",
        ], {
            cwd: process.cwd(), env: { ...process.env, CONCURRENT_PER_GAME: value }, encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '1');
    });
}
