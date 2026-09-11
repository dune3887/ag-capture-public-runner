import { spawn } from 'child_process';
import path from 'path';
import { MongoClient } from 'mongodb';
import { stagingCollectionName, splitQuota } from './campaign';
import { loadGameTargets } from './game-target';
import { AG_CAPTURE_SOURCE, AG_CAPTURE_VERSION } from '../src/ag.version';
import { LANES, TARGET, RollingGame, RollingPayload, TaskKind, taskId, validateRollingPayload } from './rolling-contract';

/**
 * 单条通道的时间预算。
 *
 * 上限来自 GitHub Actions 的 job 超时（.github/workflows/capture-ag-rolling.yml 的
 * timeout-minutes: 350），这是平台硬限制、通道侧无法绕过，所以留 10 分钟余量让通道
 * 自行收尾，而不是在第 350 分钟被 SIGKILL。
 *
 * 2026-09-11 由 300 提到 340：原值会让所有通道在批次结束前约 50 分钟就不再接新游戏
 * （实测 12 条通道空转、同时 3 款游戏无人采集），而 GitHub 侧还有 50 分钟额度没用上。
 *
 * 注意：该 deadline 同时是「等待 canary 完成」循环的唯一出口，不能直接删除，
 * 否则 canary 永不完成（例如其他通道崩在 canary 阶段）时会死循环。
 */
export const LANE_BUDGET_MINUTES = 340;
export const LANE_BUDGET_MS = LANE_BUDGET_MINUTES * 60_000;

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'blocked';
export interface TaskRecord { _id: string; status: TaskStatus }
export interface TaskStore {
    read(id: string): Promise<TaskRecord>;
    claim(id: string, owner: string): Promise<boolean>;
    finish(id: string, owner: string, status: 'success' | 'failed' | 'blocked', exitCode: number): Promise<void>;
    verify(kind: TaskKind, index: number, quota: number): Promise<void>;
    close(): Promise<void>;
}
export interface RunnerDependencies {
    connect(game: RollingGame, queueId: string): Promise<TaskStore>;
    run(game: RollingGame, kind: TaskKind, index: number, quota: number, owner: string): Promise<number>;
    now(): number;
    pause(): Promise<void>;
    log(message: string): void;
}

export function childEnvironment(game: RollingGame, kind: TaskKind, index: number, quota: number,
    owner: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    // 仅继承运行时环境，禁止把整个队列 Secret、旧采集参数或其他游戏凭据传入子进程。
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'CI']) {
        if (inherited[key] !== undefined) env[key] = inherited[key];
    }
    return { ...env, MONGO_URI: game.mongoUri, ONLY_GAME: game.gameId, TEST_RTP: '1',
        FREE_CHOICE_PER_OPTION: '0', SPIN_DELAY_MS: '200', RETRY_ATTEMPTS: '5', RETRY_DELAY_MS: '2000',
        LOG_INTERVAL: '250', CAPTURE_CAMPAIGN_ID: `${game.campaignId}${kind === 'canary' ? '-canary' : ''}`,
        CAPTURE_WORKER_INDEX: String(index), CAPTURE_OWNER_ID: owner,
        CAPTURE_LEASE_ID: `gh_${game.campaignId}_${kind}_${index}`,
        AG_SIMULATE_COLLECTION: stagingCollectionName(game.dbName, game.campaignId, index, kind),
        SPIN_LIMIT: String(quota), CONCURRENT_PER_GAME: kind === 'canary' ? '1' : '8' };
}

export async function runLane(payload: RollingPayload, lane: number, runId: string, deps: RunnerDependencies): Promise<boolean> {
    taskId('worker', lane);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(runId)) throw new Error('invalid workflow run id');
    const deadline = deps.now() + LANE_BUDGET_MS;
    let healthy = true;
    for (const game of payload.games) {
        if (deps.now() >= deadline) break;
        let store: TaskStore | undefined;
        const worker = taskId('worker', lane);
        const owner = (kind: TaskKind, index: number) => `${runId}:${lane}:${kind}:${index}`;
        const execute = async (kind: TaskKind, index: number, quota: number) => {
            let code = 1;
            try {
                code = await deps.run(game, kind, index, quota, owner(kind, index));
                if (code === 0) await store.verify(kind, index, quota);
            } catch { code = 1; }
            await store.finish(taskId(kind, index), owner(kind, index), code === 0 ? 'success' : 'failed', code);
            deps.log(`game=${game.gameId} lane=${lane} task=${kind}:${index} exit=${code}`);
        };
        try {
            store = await deps.connect(game, payload.queueId);
            if ((await store.read(worker)).status !== 'pending') continue;
            let ready = false;
            while (deps.now() < deadline) {
                const records = await Promise.all([store.read('canary:1'), store.read('canary:2')]);
                if (records.some((r) => r.status === 'failed' || r.status === 'blocked')) break;
                if (records.every((r) => r.status === 'success')) { ready = true; break; }
                let claimed = false;
                for (let index = 1; index <= 2; index++) {
                    if (records[index - 1].status === 'pending'
                        && await store.claim(taskId('canary', index), owner('canary', index))) {
                        await execute('canary', index, 10); claimed = true; break;
                    }
                }
                if (!claimed) await deps.pause();
            }
            if (deps.now() >= deadline) break;
            if (!await store.claim(worker, owner('worker', lane))) continue;
            if (!ready) await store.finish(worker, owner('worker', lane), 'blocked', 1);
            else await execute('worker', lane, splitQuota(TARGET - game.baseline, LANES)[lane - 1]);
        } catch {
            // Mongo 写入结果不确定时不猜测终态；控制器等待 job 结束及租约消失后处理。
            healthy = false;
            deps.log(`game=${game.gameId} lane=${lane} storage-error; task state requires controller review`);
        } finally {
            try { await store?.close(); } catch {
                healthy = false;
                deps.log(`game=${game.gameId} lane=${lane} storage-close-error`);
            }
        }
    }
    return healthy;
}

async function connect(game: RollingGame, queueId: string): Promise<TaskStore> {
    const client = new MongoClient(game.mongoUri, { maxPoolSize: 2, serverSelectionTimeoutMS: 60_000, connectTimeoutMS: 30_000 });
    try { await client.connect(); } catch { await client.close(); throw new Error('rolling Mongo connection failed'); }
    const db = client.db(game.dbName);
    const tasks = db.collection<TaskRecord>('capture_queue');
    const identity = { queueId, campaignId: game.campaignId };
    return {
        async read(id) {
            const row = await tasks.findOne({ _id: id, ...identity });
            if (!row || !['pending', 'running', 'success', 'failed', 'blocked'].includes(row.status)) throw new Error('missing or invalid rolling task');
            return row;
        },
        async claim(id, owner) {
            return !!await tasks.findOneAndUpdate({ _id: id, ...identity, status: 'pending' },
                { $set: { status: 'running', owner, startedAt: new Date(), updatedAt: new Date() } }, { returnDocument: 'after' });
        },
        async finish(id, owner, status, exitCode) {
            const result = await tasks.updateOne({ _id: id, ...identity, status: 'running', owner },
                { $set: { status, exitCode, finishedAt: new Date(), updatedAt: new Date() } });
            if (result.matchedCount !== 1) throw new Error('rolling task ownership lost');
        },
        async verify(kind, index, quota) {
            const collection = db.collection(stagingCollectionName(game.dbName, game.campaignId, index, kind));
            const [total, valid] = await Promise.all([collection.countDocuments({}), collection.countDocuments({
                'rtp.0': { $exists: true }, 'data.captureSource': AG_CAPTURE_SOURCE,
                'data.captureVersion': AG_CAPTURE_VERSION,
                'data.captureCampaignId': `${game.campaignId}${kind === 'canary' ? '-canary' : ''}`,
                'data.captureWorkerIndex': index,
            })]);
            if (valid !== total || total < quota || total > quota + (kind === 'canary' ? 0 : 7)) throw new Error('staging validation failed');
        },
        close: () => client.close(),
    };
}

export function sanitizeOutput(value: string): string {
    return value.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[REDACTED_MONGO_URI]');
}

function runChild(game: RollingGame, kind: TaskKind, index: number, quota: number, owner: string): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-r', 'ts-node/register', 'ag.ts'], {
            cwd: process.cwd(), env: childEnvironment(game, kind, index, quota, owner), stdio: ['ignore', 'pipe', 'pipe'],
        });
        // 按行过滤并限制单行大小，防止 URI 跨 chunk 泄漏以及无限缓冲。
        for (const stream of [child.stdout, child.stderr]) {
            let pending = ''; let discarded = false;
            stream.setEncoding('utf8');
            stream.on('data', (chunk: string) => {
                for (const [index, part] of chunk.split('\n').entries()) {
                    if (index > 0) {
                        if (!discarded) process.stdout.write(sanitizeOutput(pending) + '\n');
                        pending = ''; discarded = false;
                    }
                    if (!discarded) { pending += part; if (pending.length > 16384) { pending = ''; discarded = true; } }
                }
            });
            stream.on('end', () => { if (pending && !discarded) process.stdout.write(sanitizeOutput(pending) + '\n'); });
        }
        let spawnFailed = false;
        child.on('error', () => { spawnFailed = true; });
        child.on('close', (code) => resolve(spawnFailed ? 1 : code ?? 1));
    });
}

async function main(): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(process.env.AG_ROLLING_PAYLOAD || ''); } catch { throw new Error('invalid rolling secret JSON'); }
    const payload = validateRollingPayload(raw, loadGameTargets(path.resolve('ag-games.yml')));
    if (process.env.QUEUE_ID !== payload.queueId) throw new Error('rolling queue id mismatch');
    delete process.env.AG_ROLLING_PAYLOAD;
    const healthy = await runLane(payload, Number(process.env.ROLLING_LANE), process.env.GITHUB_RUN_ID || '', {
        connect, run: runChild, now: Date.now, pause: () => new Promise((resolve) => setTimeout(resolve, 3000)), log: console.log,
    });
    if (!healthy) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error('rolling worker stopped; pending/running records preserved for controller review'); process.exitCode = 1; });
