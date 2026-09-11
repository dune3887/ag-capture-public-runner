import assert from 'node:assert/strict';
import { LANE_BUDGET_MINUTES } from '../scripts/rolling-worker';
import test from 'node:test';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { RollingGame, RollingPayload, taskId, validateRollingPayload } from '../scripts/rolling-contract';
import { childEnvironment, runLane, TaskRecord, TaskStatus, TaskStore, sanitizeOutput } from '../scripts/rolling-worker';

const game = (id: string): RollingGame => ({ gameId: id, dbName: `ag_${id}`, campaignId: `campaign-${id}`,
    baseline: 200000, mongoUri: ['mongodb://', 'agcap_fixture', ':', 'fixture', '@localhost/', `ag_${id}?authSource=ag_${id}`].join('') });
const payload: RollingPayload = { version: 1, queueId: 'queue-test', games: [game('A'), game('B')] };
const manifest = payload.games.map((g) => ({ ...g, name: g.gameId, serviceDir: g.gameId }));

test('payload rejects wrong bindings, credentials, duplicates and unsafe baselines', () => {
    assert.equal(validateRollingPayload(payload, manifest), payload);
    for (const mutate of [
        (p) => { p.games[0].dbName = 'ag_B'; },
        (p) => { p.games[0].mongoUri = p.games[0].mongoUri.replace('authSource=ag_A', 'authSource=admin'); },
        (p) => { p.games[0].mongoUri = p.games[0].mongoUri.replace('agcap_fixture', 'admin'); },
        (p) => { p.games[0].baseline = 270000; },
        (p) => { p.games.push(p.games[0]); },
        (p) => { p.queueId = '../unsafe'; },
    ]) {
        const copy = JSON.parse(JSON.stringify(payload)); mutate(copy);
        assert.throws(() => validateRollingPayload(copy, manifest));
    }
    assert.throws(() => taskId('worker', 21));
    assert.throws(() => taskId('canary', 3));
});

test('child environment contains only current credential and fixed capture limits', () => {
    const env = childEnvironment(game('A'), 'worker', 2, 5000, 'run:2:worker:2', {
        PATH: 'runtime', AG_ROLLING_PAYLOAD: JSON.stringify(payload), MONGO_URI: 'old', CAPTURE_CLEAR: '1',
        NODE_OPTIONS: '--bad', SPIN_LIMIT: '999', TOKEN: 'other-game',
    });
    assert.equal(env.MONGO_URI, game('A').mongoUri);
    assert.equal(env.CONCURRENT_PER_GAME, '8');
    assert.equal(env.SPIN_LIMIT, '5000');
    for (const key of ['AG_ROLLING_PAYLOAD', 'CAPTURE_CLEAR', 'NODE_OPTIONS', 'TOKEN']) assert.equal(env[key], undefined);
    const canary = childEnvironment(game('A'), 'canary', 1, 10, 'owner', {});
    assert.equal(canary.CAPTURE_CAMPAIGN_ID, 'campaign-A-canary');
    assert.equal(canary.AG_SIMULATE_COLLECTION, 'simulate_gh_ag_A_campaign-A_canary_1');
    assert.equal(canary.CONCURRENT_PER_GAME, '1');
    assert.equal(sanitizeOutput(`error ${game('A').mongoUri}`), 'error [REDACTED_MONGO_URI]');
});

function stores(canaries: TaskStatus = 'success') {
    const all = new Map<string, Map<string, TaskRecord & { owner?: string }>>();
    for (const g of payload.games) {
        const rows = new Map<string, TaskRecord & { owner?: string }>();
        for (let i = 1; i <= 20; i++) rows.set(`worker:${i}`, { _id: `worker:${i}`, status: 'pending' });
        for (let i = 1; i <= 2; i++) rows.set(`canary:${i}`, { _id: `canary:${i}`, status: canaries });
        all.set(g.gameId, rows);
    }
    const connect = async (g: RollingGame): Promise<TaskStore> => {
        const rows = all.get(g.gameId)!;
        return {
            read: async (id) => ({ ...rows.get(id)! }),
            claim: async (id, owner) => {
                const row = rows.get(id)!;
                if (row.status !== 'pending') return false;
                row.status = 'running'; row.owner = owner; return true;
            },
            finish: async (id, owner, status) => {
                const row = rows.get(id)!;
                assert.equal(row.owner, owner); assert.equal(row.status, 'running'); row.status = status;
            },
            verify: async () => {}, close: async () => {},
        };
    };
    return { all, connect };
}
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

test('fast lane enters B while slow lane still runs A; failed shard continues to B', async () => {
    const { all, connect } = stores();
    let release: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const observed: string[] = [];
    const deps = { connect, now: () => 0, pause, log: () => {},
        run: async (g, kind, index) => {
            observed.push(`${g.gameId}:${index}`);
            if (g.gameId === 'A' && index === 1) await slow;
            if (g.gameId === 'B' && index === 2) {
                assert.equal(all.get('A')!.get('worker:1')!.status, 'running'); release();
            }
            return g.gameId === 'A' && index === 2 ? 78 : 0;
        } };
    await Promise.all([runLane(payload, 1, 'run', deps), runLane(payload, 2, 'run', deps)]);
    assert.equal(all.get('A')!.get('worker:2')!.status, 'failed');
    assert.equal(all.get('B')!.get('worker:2')!.status, 'success');
    assert.ok(observed.indexOf('B:2') < observed.indexOf('B:1'));
});

test('twenty lanes atomically share exactly two canaries per game before workers', async () => {
    const { all, connect } = stores('pending');
    const calls = new Map<string, number>();
    const active = new Set<number>();
    await Promise.all(Array.from({ length: 20 }, (_, n) => runLane(payload, n + 1, 'run', {
        connect, now: () => 0, pause, log: () => {},
        run: async (g, kind, index, quota, owner) => {
            const lane = Number(owner.split(':')[1]);
            assert.ok(!active.has(lane)); active.add(lane);
            const key = `${g.gameId}:${kind}:${index}`; calls.set(key, (calls.get(key) || 0) + 1);
            if (kind === 'worker') for (const i of [1, 2]) assert.equal(all.get(g.gameId)!.get(`canary:${i}`)!.status, 'success');
            else assert.equal(quota, 10);
            await pause(); active.delete(lane); return 0;
        },
    })));
    assert.equal(calls.size, 44);
    for (const count of calls.values()) assert.equal(count, 1);
});

test('failed canary blocks formal shards while lanes continue to next game', async () => {
    const { all, connect } = stores('pending');
    await Promise.all([1, 2, 3].map((lane) => runLane(payload, lane, 'run', {
        connect, now: () => 0, pause, log: () => {}, run: async (g, kind) => {
            if (g.gameId === 'A') { assert.equal(kind, 'canary'); return 78; }
            return 0;
        },
    })));
    for (const lane of [1, 2, 3]) {
        assert.equal(all.get('A')!.get(`worker:${lane}`)!.status, 'blocked');
        assert.equal(all.get('B')!.get(`worker:${lane}`)!.status, 'success');
    }
});

test('soft cutoff leaves next game pending and never steals a running shard', async () => {
    const { all, connect } = stores(); let now = 0;
    await runLane(payload, 1, 'run', { connect, now: () => now, pause, log: () => {},
        run: async () => { now = (LANE_BUDGET_MINUTES + 1) * 60_000; return 0; } });
    assert.equal(all.get('B')!.get('worker:1')!.status, 'pending');
    all.get('A')!.get('worker:2')!.status = 'running';
    await runLane({ ...payload, games: [game('A')] }, 2, 'run', { connect, now: () => 0, pause, log: () => {},
        run: async () => { assert.fail('running shard was stolen'); } });
});

test('connection failure is isolated and produces failed lane outcome after B', async () => {
    const { all, connect } = stores();
    const logs: string[] = [];
    const healthy = await runLane(payload, 1, 'run', {
        connect: async (g) => { if (g.gameId === 'A') throw new Error(game('A').mongoUri); return connect(g); },
        now: () => 0, pause, log: (line) => logs.push(line), run: async () => 0,
    });
    assert.equal(healthy, false);
    assert.equal(all.get('A')!.get('worker:1')!.status, 'pending');
    assert.equal(all.get('B')!.get('worker:1')!.status, 'success');
    assert.ok(logs.every((line) => !line.includes('mongodb')));
});

test('verification failure marks failed and advances without retry', async () => {
    const { all, connect } = stores(); const calls: string[] = [];
    await runLane(payload, 1, 'run', {
        connect: async (g) => ({ ...await connect(g), verify: async () => { if (g.gameId === 'A') throw new Error('invalid staging'); } }),
        now: () => 0, pause, log: () => {}, run: async (g) => { calls.push(g.gameId); return 0; },
    });
    assert.deepEqual(calls, ['A', 'B']);
    assert.equal(all.get('A')!.get('worker:1')!.status, 'failed');
    assert.equal(all.get('B')!.get('worker:1')!.status, 'success');
});

test('uncertain terminal write retains running until controller resolves and B still runs', async () => {
    const { all, connect } = stores(); let childActive = false;
    const healthy = await runLane(payload, 1, 'run', {
        connect: async (g) => {
            const store = await connect(g);
            return { ...store, finish: async (...args) => {
                assert.equal(childActive, false);
                if (g.gameId === 'A') throw new Error('write uncertain');
                await store.finish(...args);
            }, close: async () => { if (g.gameId === 'A') throw new Error('close failed'); } };
        },
        now: () => 0, pause, log: () => {}, run: async () => { childActive = true; await pause(); childActive = false; return 0; },
    });
    assert.equal(healthy, false);
    assert.equal(all.get('A')!.get('worker:1')!.status, 'running');
    assert.equal(all.get('B')!.get('worker:1')!.status, 'success');
});

test('cutoff while waiting for canary preserves all unstarted tasks', async () => {
    const { all, connect } = stores('running'); let now = 0; let calls = 0;
    await runLane(payload, 1, 'run', { connect, now: () => now,
        pause: async () => { now = LANE_BUDGET_MINUTES * 60_000; }, log: () => {}, run: async () => { calls++; return 0; } });
    assert.equal(calls, 0);
    for (const id of ['A', 'B']) assert.equal(all.get(id)!.get('worker:1')!.status, 'pending');
});

test('single and rolling workflows share global queue lock', () => {
    for (const name of ['capture-ag-game', 'capture-ag-rolling']) {
        const doc = yaml.load(fs.readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as any;
        assert.deepEqual(doc.concurrency, { group: 'ag-capture-global', 'cancel-in-progress': false });
    }
});
