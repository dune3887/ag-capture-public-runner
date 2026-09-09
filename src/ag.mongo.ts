import Decimal from 'decimal.js';
import os from 'os';
import { Collection, MongoClient, MongoClientOptions, ObjectId } from 'mongodb';
import {
    CAPTURE_LEASE_ID,
    MONGO_CONNECT_TIMEOUT_MS,
    MONGO_MAX_POOL_SIZE,
    MONGO_SERVER_SELECTION_TIMEOUT_MS,
    MONGO_URI,
    TEST_RTP,
} from '../config';
import {
    AGCompletedRound,
    AGGameLeaseDoc,
    AGHandshakeDoc,
    AGMongoCounts,
    AGMongoDoc,
} from './ag.types';
import { AG_CAPTURE_SOURCE, AG_CAPTURE_VERSION } from './ag.version';

export function normalizeLeaseId(value: string): string {
    const normalized = String(value || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(normalized)) {
        throw new Error(`invalid capture lease id: ${normalized}`);
    }
    return normalized;
}

export const GAME_LEASE_DOC_ID = normalizeLeaseId(CAPTURE_LEASE_ID);

export function mongoClientOptions(): MongoClientOptions {
    return {
        maxPoolSize: MONGO_MAX_POOL_SIZE,
        minPoolSize: 0,
        serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
        connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
    };
}
const SIMULATE_COLLECTION_NAME = (() => {
    const value = String(process.env.AG_SIMULATE_COLLECTION || 'simulate').trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
        throw new Error(`invalid AG_SIMULATE_COLLECTION: ${value}`);
    }
    return value;
})();

// 兼容清理历史 seed-local 数据，并防止误运行种子脚本后污染真实采集进度。
export const AG_SYNTHETIC_DATA_CONDITIONS: Record<string, any>[] = [
    { 'data.captureSource': 'synthetic-seed' },
    {
        $and: [
            { 'data.GameReferenceInfo.gameReference': '' },
            { 'data.PlayerBalanceInfo.preWagerBalance': 1000 },
            { 'data.GameWageringInfo.currentBets': { $size: 88 } },
            { 'data.NextActionInfo.id': 'BASE' },
        ],
    },
];

export function realDataFilter(): Record<string, any> {
    return { $nor: AG_SYNTHETIC_DATA_CONDITIONS };
}

const DEFAULT_RTPS = TEST_RTP
    ? (process.env.RTP_BUCKETS || '0,30,50,100,200,300,500,1000,2000,3000,5000')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value))
    : [];

function toPlainObject<T>(value: T): T {
    return JSON.parse(JSON.stringify(value ?? {}));
}

function toDecimal(value: unknown): Decimal | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    try {
        const result = new Decimal(value as Decimal.Value);
        return result.isFinite() ? result : null;
    } catch {
        return null;
    }
}

function normalizeDbName(dbName?: string): string {
    return dbName && dbName.trim() ? dbName.trim() : 'db_ag';
}

export function canAcquireGameLease(
    lease: Pick<AGGameLeaseDoc, 'ownerId' | 'expiresAt'> | null | undefined,
    ownerId: string,
    now = new Date(),
): boolean {
    if (!lease) {
        return true;
    }
    if (lease.ownerId === ownerId) {
        return true;
    }

    const expiresAt = lease.expiresAt instanceof Date
        ? lease.expiresAt
        : new Date(lease.expiresAt);
    return Number.isFinite(expiresAt.getTime()) && expiresAt <= now;
}

function isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && Number((error as { code?: unknown }).code) === 11000;
}

export async function insertMongoDocWithRetry(
    insert: (doc: AGMongoDoc) => Promise<unknown>,
    doc: AGMongoDoc,
    retryAttempts = 3,
    retryDelayMs = 250,
): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await insert(doc);
            return;
        } catch (error) {
            // 首次写入可能已在服务端成功但客户端未收到确认；固定 _id 的重复键等价于写入成功。
            if (isDuplicateKeyError(error)) {
                return;
            }
            if (attempt >= retryAttempts) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs * Math.pow(2, attempt)));
        }
    }
}

function finiteNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function validateCompletedRound(round: AGCompletedRound): void {
    const bet = finiteNumber(round.bet);
    const win = finiteNumber(round.win);
    if (bet === null || bet <= 0) {
        throw new Error('AG integrity: bet must be positive');
    }
    if (win === null || win < 0) {
        throw new Error('AG integrity: win must be a non-negative finite number');
    }

    const events = round.data?.roundEvents;
    if (!Array.isArray(events) || events.length === 0 || events.some((event) => !String(event || '').trim())) {
        throw new Error('AG integrity: completed round is missing roundEvents');
    }
    const roundTrigger = round.data?.roundTrigger;
    if (!roundTrigger || typeof roundTrigger !== 'object' || Array.isArray(roundTrigger)) {
        throw new Error('AG integrity: completed round is missing roundTrigger');
    }
    if (round.data.roundSchemaVersion >= 3) validateReplaySequence(round.data);
    const groups = round.data?.captureSampleGroups;
    if (!Array.isArray(groups) || groups.length === 0) {
        throw new Error('AG integrity: completed round is missing captureSampleGroups');
    }
    const resolution = round.data?.winResolution;
    if (!resolution || !['balance-delta', 'protocol'].includes(String(resolution.method))) {
        throw new Error('AG integrity: completed round is missing winResolution');
    }

    const resultAmount = finiteNumber(round.data?.PlayerBalanceInfo?.resultAmount);
    if (resultAmount === null || Math.abs(resultAmount - win) > 1e-7) {
        throw new Error(`AG integrity: stored resultAmount ${resultAmount} does not match win ${win}`);
    }

    const balanceDerivedWin = finiteNumber(resolution.balanceDerivedWin);
    if (resolution.balanceDerivedWin !== null
        && resolution.balanceDerivedWin !== undefined
        && (balanceDerivedWin === null || Math.abs(balanceDerivedWin - win) > 1e-7)) {
        throw new Error(`AG integrity: balance-derived win ${balanceDerivedWin} does not match win ${win}`);
    }

    const preWagerBalance = finiteNumber(round.data?.PlayerBalanceInfo?.preWagerBalance);
    const finalBalance = finiteNumber(round.balance ?? round.data?.PlayerBalanceInfo?.balance);
    if (preWagerBalance !== null && finalBalance !== null) {
        const expectedWin = Number((finalBalance - preWagerBalance + bet).toFixed(12));
        if (expectedWin >= -1e-7 && Math.abs(Math.max(expectedWin, 0) - win) > 1e-7) {
            throw new Error(`AG integrity: balance delta ${expectedWin} does not match win ${win}`);
        }
    }
}

// 新格式必须是可以连续回放的大局；遇到协议尚未支持的终止方式，保留错误而不是打标签。
export function validateReplaySequence(data: Record<string, any>): void {
    if (data.XmlEvents && !['response', 'balance-delta'].includes(data.roundBetSource)) throw new Error('AG integrity: XML wager lacks authoritative source');
    const finalAction = String(data.roundTerminalAction || '').toUpperCase();
    if (!['SPIN','BASE','NORMAL','WAGER','PLAY'].includes(finalAction)) throw new Error('AG integrity: invalid terminal action');
    const terminal = (action: unknown) => String(action || '').toUpperCase() === finalAction;
    const steps = data.freeChoiceSteps;
    if (!Array.isArray(steps) || !data.roundTrigger?.NextActionInfo?.nextAction) throw new Error('AG integrity: missing replay sequence');
    if (data.requiresSessionReset) throw new Error('AG integrity: replay requires unsupported session reset');
    if (!Number.isFinite(data.roundWin) || data.roundWin < 0) throw new Error('AG integrity: invalid roundWin');
    let current = data.roundTrigger;
    for (const step of steps) {
        if (!step?.event || !step.data?.NextActionInfo?.nextAction || step.action !== current.NextActionInfo?.nextAction?.toUpperCase()
            || !Object.prototype.hasOwnProperty.call(step, 'parameters')) throw new Error('AG integrity: incomplete replay request or action chain');
        if (terminal(current.NextActionInfo?.nextAction)) throw new Error('AG integrity: terminal response has follow-ups');
        if (step.requiresPickIndex && (step.parameters?.pickIndex === undefined || step.parameters.pickIndex === null)) {
            throw new Error('AG integrity: indexed pick missing captured pickIndex');
        }
        current = step.data;
    }
    if (!terminal(current.NextActionInfo?.nextAction)) throw new Error('AG integrity: replay does not terminate');
}

export function buildMongoDoc(round: AGCompletedRound, rtpBuckets = DEFAULT_RTPS): AGMongoDoc {
    const bet = toDecimal(round.bet);
    if (!bet || bet.lte(0)) {
        throw new Error('invalid AG bet value');
    }

    const win = toDecimal(round.win) || new Decimal(0);
    const mul = win.div(bet);
    const optionIndex = Number(round.optionIndex || 0);
    const optionCount = Number(round.optionCount || 0);
    const data = toPlainObject(round.data) as Record<string, any>;

    data.freeChoiceOptionIndex = optionIndex;
    data.freeChoiceOptionCount = optionCount;
    if (!Array.isArray(data.freeChoiceSteps)) {
        data.freeChoiceSteps = [];
    }
    if (!Array.isArray(data.captureSampleGroups)) {
        data.captureSampleGroups = optionIndex > 0 ? [`choice:${optionIndex}`] : ['base'];
    }
    data.captureSource = AG_CAPTURE_SOURCE;
    data.captureVersion = AG_CAPTURE_VERSION;
    data.capturedAt = new Date().toISOString();
    const campaignId = String(process.env.CAPTURE_CAMPAIGN_ID || '').trim();
    const workerIndex = Number(process.env.CAPTURE_WORKER_INDEX);
    if (campaignId) {
        data.captureCampaignId = campaignId;
    }
    if (Number.isInteger(workerIndex) && workerIndex > 0) {
        data.captureWorkerIndex = workerIndex;
    }

    return {
        _id: new ObjectId(),
        bonus: round.isFeature || optionIndex > 0 ? 1 : 0,
        buy: 0,
        data,
        mul: mul.isFinite() && !mul.isNaN() ? mul.toNumber() : 0,
        rtp: [...rtpBuckets],
        bet: bet.toNumber(),
    };
}

export class AGMongoStore {
    private client: MongoClient | null = null;
    private readonly simulateCollections = new Map<string, Collection<AGMongoDoc>>();
    private readonly handshakeCollections = new Map<string, Collection<AGHandshakeDoc>>();
    private readonly leaseCollections = new Map<string, Collection<AGGameLeaseDoc>>();
    private readonly indexedDbs = new Set<string>();

    getMongoTarget(): string {
        if (MONGO_URI) {
            try {
                const url = new URL(MONGO_URI);
                return url.host;
            } catch {
                return 'MONGO_URI';
            }
        }
        return 'not-configured';
    }

    getSimulateCollectionName(): string {
        return SIMULATE_COLLECTION_NAME;
    }

    private async getClient(): Promise<MongoClient> {
        if (!this.client) {
            if (!MONGO_URI) {
                throw new Error('MONGO_URI is required');
            }
            this.client = new MongoClient(MONGO_URI, mongoClientOptions());
            await this.client.connect();
            console.log(`[mongo] connected ${this.getMongoTarget()}`);
        }
        return this.client;
    }

    private async getSimulateCollection(dbName: string): Promise<Collection<AGMongoDoc>> {
        const normalized = normalizeDbName(dbName);
        const cached = this.simulateCollections.get(normalized);
        if (cached) {
            return cached;
        }

        const client = await this.getClient();
        const collection = client.db(normalized).collection<AGMongoDoc>(SIMULATE_COLLECTION_NAME);
        this.simulateCollections.set(normalized, collection);
        return collection;
    }

    private async getHandshakeCollection(dbName: string): Promise<Collection<AGHandshakeDoc>> {
        const normalized = normalizeDbName(dbName);
        const cached = this.handshakeCollections.get(normalized);
        if (cached) {
            return cached;
        }

        const client = await this.getClient();
        const collection = client.db(normalized).collection<AGHandshakeDoc>('handshake');
        this.handshakeCollections.set(normalized, collection);
        return collection;
    }

    private async getLeaseCollection(dbName: string): Promise<Collection<AGGameLeaseDoc>> {
        const normalized = normalizeDbName(dbName);
        const cached = this.leaseCollections.get(normalized);
        if (cached) {
            return cached;
        }

        const client = await this.getClient();
        const collection = client.db(normalized).collection<AGGameLeaseDoc>('capture_locks');
        this.leaseCollections.set(normalized, collection);
        return collection;
    }

    private async ensureIndexes(dbName: string) {
        const normalized = normalizeDbName(dbName);
        if (this.indexedDbs.has(normalized)) {
            return;
        }

        const collection = await this.getSimulateCollection(normalized);
        await collection.createIndex({ buy: 1 });
        await collection.createIndex({ bonus: 1 });
        await collection.createIndex({ 'data.freeChoiceOptionIndex': 1 });
        await collection.createIndex({ 'data.captureSampleGroups': 1 });
        await collection.createIndex({ 'data.captureVersion': 1 });
        this.indexedDbs.add(normalized);
    }

    async getCounts(dbName: string): Promise<AGMongoCounts> {
        const collection = await this.getSimulateCollection(dbName);
        // 旧版本/缺原始触发的记录不再冒充新格式的已完成配额。
        const realOnly = { ...realDataFilter(), 'data.captureVersion': AG_CAPTURE_VERSION,
            'data.roundSchemaVersion': 3, 'data.roundTrigger.NextActionInfo.nextAction': {$type:'string'},
            $or: [{'data.XmlEvents':{$exists:false}}, {'data.roundBetSource':{$in:['response','balance-delta']}}] };
        const [total, base, optionRows, feature, eventRows] = await Promise.all([
            collection.countDocuments(realOnly),
            collection.countDocuments({
                $and: [
                    realOnly,
                    {
                        $or: [
                            { 'data.captureSampleGroups': 'base' },
                            {
                                $and: [
                                    { 'data.captureSampleGroups': { $exists: false } },
                                    {
                                        $or: [
                                            { 'data.freeChoiceOptionIndex': { $exists: false } },
                                            { 'data.freeChoiceOptionIndex': { $in: [null, 0] } },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            }),
            collection
                .aggregate<{ _id: number; count: number; optionCount: number }>([
                    {
                        $match: {
                            $and: [
                                realOnly,
                                { 'data.freeChoiceOptionIndex': { $gt: 0 } },
                            ],
                        },
                    },
                    {
                        $group: {
                            _id: '$data.freeChoiceOptionIndex',
                            count: { $sum: 1 },
                            optionCount: { $max: '$data.freeChoiceOptionCount' },
                        },
                    },
                ])
                .toArray(),
            collection.countDocuments({ ...realOnly, bonus: 1 }),
            collection.aggregate<{_id:string;count:number}>([
                {$match:realOnly},
                {$project:{events:{$setUnion:[{$map:{input:{$ifNull:['$data.roundEvents',[]]},as:'event',in:{$toLower:'$$event'}}},[]]}}},
                {$unwind:'$events'}, {$group:{_id:'$events',count:{$sum:1}}},
            ]).toArray(),
        ]);

        const freeChoiceOptions: Record<number, number> = {};
        let optionCount = 0;
        for (const row of optionRows) {
            const optionIndex = Number(row._id);
            if (!Number.isFinite(optionIndex) || optionIndex <= 0) {
                continue;
            }

            freeChoiceOptions[optionIndex] = Number(row.count || 0);
            optionCount = Math.max(optionCount, optionIndex, Number(row.optionCount || 0));
        }

        return { base, total, optionCount, freeChoiceOptions, feature,
            events:Object.fromEntries(eventRows.map(row=>[row._id,row.count])) };
    }

    async getValidationRequirements(dbName: string): Promise<{optionCount:number;hasFeature:boolean;events:string[]}> {
        const client = await this.getClient();
        const collection = client.db(normalizeDbName(dbName)).collection('simulate');
        const [row] = await collection.aggregate([
            {$match:{...realDataFilter(),bonus:1}},
            {$group:{_id:null,optionCount:{$max:'$data.freeChoiceOptionCount'}}},
        ]).toArray();
        const events = await collection.distinct('data.roundEvents', {...realDataFilter(),bonus:1});
        return {optionCount: Number(row?.optionCount || 0), hasFeature: !!row,
            events:[...new Set(events.map(event=>String(event).toLowerCase()).filter(event=>!['spin','wager','play',''].includes(event)))]};
    }

    async insertRound(dbName: string, round: AGCompletedRound, rtpBuckets?: number[]): Promise<AGMongoDoc> {
        validateCompletedRound(round);
        await this.ensureIndexes(dbName);
        const collection = await this.getSimulateCollection(dbName);
        const doc = buildMongoDoc(round, rtpBuckets ?? DEFAULT_RTPS);
        await insertMongoDocWithRetry((value) => collection.insertOne(value), doc);
        return doc;
    }

    async tryAcquireGameLease(dbName: string, gameId: string, ownerId: string, leaseMs: number): Promise<boolean> {
        const normalized = normalizeDbName(dbName);
        const collection = await this.getLeaseCollection(normalized);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + Math.max(leaseMs, 1000));

        try {
            const result = await collection.updateOne(
                {
                    _id: GAME_LEASE_DOC_ID,
                    $or: [
                        { ownerId },
                        { expiresAt: { $lte: now } },
                        { expiresAt: { $exists: false } },
                    ],
                },
                {
                    $set: {
                        ownerId,
                        gameId,
                        dbName: normalized,
                        hostname: os.hostname(),
                        pid: process.pid,
                        updatedAt: now,
                        expiresAt,
                    },
                    $setOnInsert: { createdAt: now },
                },
                { upsert: true },
            );
            return result.upsertedCount > 0 || result.matchedCount > 0 || result.modifiedCount > 0;
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                return false;
            }
            throw error;
        }
    }

    async renewGameLease(dbName: string, ownerId: string, leaseMs: number): Promise<boolean> {
        const collection = await this.getLeaseCollection(dbName);
        const now = new Date();
        const result = await collection.updateOne(
            { _id: GAME_LEASE_DOC_ID, ownerId },
            {
                $set: {
                    updatedAt: now,
                    expiresAt: new Date(now.getTime() + Math.max(leaseMs, 1000)),
                },
            },
        );
        return result.matchedCount > 0;
    }

    async releaseGameLease(dbName: string, ownerId: string): Promise<void> {
        const collection = await this.getLeaseCollection(dbName);
        await collection.deleteOne({ _id: GAME_LEASE_DOC_ID, ownerId });
    }

    async saveHandshake(dbName: string, data: Record<string, any>) {
        const collection = await this.getHandshakeCollection(dbName);
        await collection.updateOne(
            { _id: 'latest' },
            { $set: { data: toPlainObject(data), updatedAt: new Date() } },
            { upsert: true },
        );
    }

    async clearGame(dbName: string): Promise<void> {
        const [simulate, handshake] = await Promise.all([
            this.getSimulateCollection(dbName),
            this.getHandshakeCollection(dbName),
        ]);
        await Promise.all([simulate.deleteMany({}), handshake.deleteMany({})]);
    }

    async close(): Promise<void> {
        if (!this.client) {
            return;
        }

        await this.client.close();
        this.client = null;
        this.simulateCollections.clear();
        this.handshakeCollections.clear();
        this.leaseCollections.clear();
        this.indexedDbs.clear();
    }
}
