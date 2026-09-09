import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildCaptureState, ensureChoiceTasks } from '../src/ag.plan';
import { AGSchedulerOptions, getCaptureSampleGroups, isDeterministicCaptureError, runAGScheduler, throwIfSchedulerFailed } from '../src/ag.scheduler';
import { AGCompletedRound } from '../src/ag.types';
import { AGMongoStore, validateCompletedRound } from '../src/ag.mongo';
import { RoxorCometDSession } from '../src/ag.client';
import * as capture from '../src/ag.round';

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

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}

function schedulerFixture(t: TestContext, spinLimit: number) {
    const store = new AGMongoStore();
    const stored: AGCompletedRound[] = [];
    t.mock.method(store, 'tryAcquireGameLease', async () => true);
    t.mock.method(store, 'releaseGameLease', async () => {});
    t.mock.method(store, 'getCounts', async () => ({ base: 0, total: 0, optionCount: 0, freeChoiceOptions: {} }));
    t.mock.method(store, 'insertRound', async (_db, value) => { stored.push(value); });
    t.mock.method(RoxorCometDSession.prototype, 'connect', async () => {});
    t.mock.method(RoxorCometDSession.prototype, 'getHandshakeData', () => null);
    const closing = deferred<void>();
    t.mock.method(RoxorCometDSession.prototype, 'close', () => { closing.resolve(); });
    const options: AGSchedulerOptions = {
        store, limits: { spinLimit, freeChoicePerOption: 0 }, concurrentGames: 1,
        workersPerGame: 3, retryAttempts: 2, retryDelayMs: 50, spinDelayMs: 0,
        logInterval: 0, sessionReadyDelayMs: 0, sessionRecycleDelayMs: 1000,
        workerStartJitterMs: 0, shouldClear: false, maxRoundsPerGame: 0,
        ownerId: 'scheduler-test', gameLeaseMs: 90000, gameLeaseRenewMs: 20000,
    };
    const run = () => runAGScheduler([{ gameId: 'play-test', name: 'Test', backendId: 'test' }], options)
        .then(() => null, (error: Error) => error);
    return { store, stored, closing, options, run };
}

const flushWorkers = () => new Promise<void>((resolve) => setImmediate(resolve));

function runFailureCLI(message: string, cleanupFails = false) {
    const script = `
        const scheduler = require('./src/ag.scheduler');
        scheduler.runAGScheduler = async () => {
            scheduler.throwIfSchedulerFailed([new Error(process.env.TEST_CAPTURE_ERROR)]);
        };
        if (process.env.TEST_CLOSE_FAILURE === '1') {
            require('./src/ag.mongo').AGMongoStore.prototype.close = async () => { throw new Error('read ECONNRESET'); };
        }
        process.argv = [process.execPath, require('path').resolve('ag.ts'), '--game-limit=1'];
        require('module').runMain();
    `;
    return spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', script], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
        env: { ...process.env, TEST_CAPTURE_ERROR: message, TEST_CLOSE_FAILURE: cleanupFails ? '1' : '0', ONLY_GAME: '', MONGO_URI: '' },
    });
}

function storableRound(): AGCompletedRound {
    return {
        ...round(0, false),
        data: {
            roundEvents: ['Spin'], roundTrigger: {}, winResolution: { method: 'protocol' },
            PlayerBalanceInfo: { resultAmount: 0 },
        },
    };
}

for (const quotaCompletes of [false, true]) {
    for (const cleanupFails of [false, true]) {
        test(`store validation publishes fatal across three workers: quotaCompletes=${quotaCompletes}, cleanupFails=${cleanupFails}`, async (t) => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const fixture = schedulerFixture(t, quotaCompletes ? 1 : 2);
            if (cleanupFails) {
                t.mock.method(fixture.store, 'releaseGameLease', async () => { throw new Error('read ECONNRESET'); });
            }
            const attempts = Array.from({ length: 3 }, () => deferred<AGCompletedRound>());
            const started = deferred<void>();
            const inserting = deferred<void>();
            const inserted = deferred<void>();
            const beforeFatal = storableRound();
            let calls = 0;
            t.mock.method(capture, 'captureAGRound', () => {
                const attempt = attempts[calls++];
                if (calls === 3) started.resolve();
                assert.ok(attempt, 'store fatal must prevent new rounds');
                return attempt.promise;
            });
            let validations = 0;
            t.mock.method(fixture.store, 'insertRound', async (_db, value) => {
                validations += 1;
                // 保留生产 insertRound 的真实完整性校验入口，只替换校验后的数据库写入。
                validateCompletedRound(value);
                fixture.stored.push(value);
                if (value === beforeFatal) {
                    inserting.resolve();
                    await inserted.promise;
                }
            });
            const outcome = fixture.run();
            await started.promise;
            if (quotaCompletes) {
                attempts[1].resolve(beforeFatal);
                await inserting.promise;
            }
            const invalid = storableRound();
            invalid.bet = 0;
            attempts[0].resolve(invalid);
            await fixture.closing.promise;
            if (quotaCompletes) {
                inserted.resolve();
                await flushWorkers();
            } else {
                attempts[1].resolve(storableRound());
            }
            attempts[2].resolve(storableRound());
            await flushWorkers();
            const storedDuringCleanup = [...fixture.stored];
            t.mock.timers.tick(1000);
            const error = await outcome;
            assert.deepEqual(storedDuringCleanup, quotaCompletes ? [beforeFatal] : [], 'late rounds must not reach staging during fatal cleanup');
            assert.equal(validations, quotaCompletes ? 2 : 1, 'late rounds must not even reach insertRound');
            assert.equal(calls, 3);
            assert.ok(error, 'a completed quota must not cover the store validation failure');
            const processResult = runFailureCLI(error.message);
            assert.equal(processResult.status, 78, processResult.stderr);
            assert.match(error.message, /AG integrity: bet must be positive/);
        });
    }
}

test('ordinary storage network failure remains retryable instead of becoming fatal', async (t) => {
    const fixture = schedulerFixture(t, 1);
    Object.assign(fixture.options, { workersPerGame: 1, sessionRecycleDelayMs: 0 });
    t.mock.method(capture, 'captureAGRound', async () => storableRound());
    t.mock.method(fixture.store, 'insertRound', async () => { throw new Error('read ECONNRESET'); });
    const error = await fixture.run();
    assert.ok(error);
    assert.match(error.message, /read ECONNRESET/);
    assert.equal(runFailureCLI(error.message).status, 1);
});

for (const message of ['AG integrity: missing round result', 'unsupported AG nextAction: BONUS_ENTRY']) {
    test(`three workers stop before storing late rounds during fatal session cleanup: ${message}`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const fixture = schedulerFixture(t, 2);
        const attempts = Array.from({ length: 3 }, () => deferred<AGCompletedRound>());
        const started = deferred<void>();
        let calls = 0;
        t.mock.method(capture, 'captureAGRound', () => {
            const attempt = attempts[calls++];
            if (calls === 3) started.resolve();
            assert.ok(attempt, 'fatal must prevent new rounds');
            return attempt.promise;
        });
        const outcome = fixture.run();
        await started.promise;
        attempts[0].reject(new Error(message));
        await fixture.closing.promise;
        // 第一线程仍在 1000ms 清理延迟内；两个迟到回合原本足以填满共享配额。
        attempts[1].resolve(round(0, false));
        attempts[2].resolve(round(0, false));
        await flushWorkers();
        const storedDuringCleanup = fixture.stored.length;
        t.mock.timers.tick(1000);
        const error = await outcome;
        assert.equal(storedDuringCleanup, 0, 'rounds returning after fatal must not reach staging');
        assert.equal(fixture.stored.length, 0);
        assert.equal(calls, 3);
        assert.ok(error, 'quota completion must not turn fatal into success');
        assert.ok(error.message.includes(message));
    });
}

for (const cleanupFails of [false, true]) {
    test(`fatal outranks completed quota even when lease cleanup fails=${cleanupFails}`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const fixture = schedulerFixture(t, 1);
        if (cleanupFails) {
            t.mock.method(fixture.store, 'releaseGameLease', async () => { throw new Error('read ECONNRESET'); });
        }
        const attempts = Array.from({ length: 3 }, () => deferred<AGCompletedRound>());
        const started = deferred<void>();
        const inserting = deferred<void>();
        const inserted = deferred<void>();
        let calls = 0;
        t.mock.method(capture, 'captureAGRound', () => {
            const attempt = attempts[calls++];
            if (calls === 3) started.resolve();
            assert.ok(attempt, 'fatal must prevent new rounds');
            return attempt.promise;
        });
        t.mock.method(fixture.store, 'insertRound', async (_db, value) => {
            fixture.stored.push(value);
            inserting.resolve();
            await inserted.promise;
        });
        const outcome = fixture.run();
        await started.promise;
        const beforeFatal = round(0, false);
        attempts[1].resolve(beforeFatal);
        await inserting.promise;
        attempts[0].reject(new Error('AG integrity: corrupt result'));
        await fixture.closing.promise;
        inserted.resolve();
        await flushWorkers();
        attempts[2].resolve(round(0, false));
        await flushWorkers();
        t.mock.timers.tick(1000);
        const error = await outcome;
        assert.deepEqual(fixture.stored, [beforeFatal]);
        assert.equal(calls, 3);
        assert.ok(error, 'completed quota must still propagate fatal');
        assert.match(error.message, /AG integrity: corrupt result/);
    });
}

test('fatal also stops workers awaiting a connection or temporary-error retry backoff', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = schedulerFixture(t, 2);
    fixture.options.sessionRecycleDelayMs = 0;
    const pendingConnection = deferred<void>();
    const pendingFatal = deferred<AGCompletedRound>();
    let connections = 0;
    t.mock.method(RoxorCometDSession.prototype, 'connect', async () => {
        if (++connections === 3) await pendingConnection.promise;
    });
    let calls = 0;
    t.mock.method(capture, 'captureAGRound', async () => {
        calls += 1;
        if (calls === 1) return pendingFatal.promise;
        if (calls === 2) throw new Error('read ETIMEDOUT');
        return round(0, false);
    });
    const outcome = fixture.run();
    await flushWorkers();
    assert.equal(connections, 3);
    assert.equal(calls, 2);
    pendingFatal.reject(new Error('AG integrity: corrupt result'));
    await flushWorkers();
    pendingConnection.resolve();
    t.mock.timers.tick(50);
    const error = await outcome;
    assert.equal(calls, 2, 'fatal must prevent captures after connection and retry awaits');
    assert.equal(connections, 3, 'fatal must prevent a retry session from opening');
    assert.equal(fixture.stored.length, 0);
    assert.ok(error);
    assert.match(error.message, /AG integrity: corrupt result/);
});

test('temporary network failure still retries and completes the quota', async (t) => {
    const fixture = schedulerFixture(t, 1);
    Object.assign(fixture.options, { workersPerGame: 1, sessionRecycleDelayMs: 0, retryDelayMs: 0 });
    let calls = 0;
    t.mock.method(capture, 'captureAGRound', async () => {
        if (++calls === 1) throw new Error('read ETIMEDOUT');
        return round(0, false);
    });
    assert.equal(await fixture.run(), null);
    assert.equal(calls, 2);
    assert.equal(fixture.stored.length, 1);
});

for (const [message, exitCode, cleanupFails] of [
    ['AG integrity: corrupt result', 78, false],
    ['unsupported AG nextAction: BONUS_ENTRY', 78, false],
    ['read ETIMEDOUT', 1, false],
    ['AG integrity: corrupt result', 78, true],
] as const) {
    test(`CLI propagates failure as exit ${exitCode}, cleanupFails=${cleanupFails}: ${message}`, () => {
        const result = runFailureCLI(message, cleanupFails);
        assert.equal(result.status, exitCode, result.stderr);
        assert.match(result.stderr, /fatal: 1 game capture failed/);
    });
}
