import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AG_SYNTHETIC_DATA_CONDITIONS,
    buildMongoDoc,
    canAcquireGameLease,
    insertMongoDocWithRetry,
    mongoClientOptions,
    normalizeLeaseId,
    realDataFilter,
    validateCompletedRound,
    validateReplaySequence,
} from '../src/ag.mongo';
import { AG_CAPTURE_SOURCE, AG_CAPTURE_VERSION } from '../src/ag.version';
import { AGCompletedRound } from '../src/ag.types';

test('mongo client options keep the pool small and tolerate recovery', () => {
    assert.deepEqual(mongoClientOptions(), {
        maxPoolSize: 2,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 60_000,
        connectTimeoutMS: 30_000,
    });
});

test('schema 3 validates the full request chain, including wager then spin', () => {
    const data: Record<string, any> = {
        roundTerminalAction: 'WAGER', roundWin: 2,
        roundTrigger: { NextActionInfo: { nextAction: 'SPIN' } },
        freeChoiceSteps: [{ action: 'SPIN', event: 'Spin', parameters: null,
            data: { NextActionInfo: { nextAction: 'WAGER' } } }],
    };
    assert.doesNotThrow(() => validateReplaySequence(data));
    const missing = structuredClone(data);
    delete missing.freeChoiceSteps[0].parameters;
    assert.throws(() => validateReplaySequence(missing), /incomplete replay request/);
    const pick = structuredClone(data);
    pick.freeChoiceSteps[0].requiresPickIndex = true;
    assert.throws(() => validateReplaySequence(pick), /missing captured pickIndex/);
    const unfinished = structuredClone(data);
    unfinished.freeChoiceSteps = [];
    assert.throws(() => validateReplaySequence(unfinished), /does not terminate/);
    assert.throws(() => validateReplaySequence({ ...data, requiresSessionReset: true }), /session reset/);
});

test('buildMongoDoc keeps completed base rounds in the simulate document format', () => {
    const round: AGCompletedRound = {
        isFeature: false,
        optionIndex: 0,
        optionCount: 0,
        bet: 0.88,
        win: 4.4,
        data: {
            PlayerBalanceInfo: { wager: '0.88', resultAmount: '4.40' },
            GameSlotResultInfo: { grossWin: '4.40' },
        },
    };

    const doc = buildMongoDoc(round, [0, 100, 500]);

    assert.equal(doc.bonus, 0);
    assert.equal(doc._id?.constructor.name, 'ObjectId');
    assert.equal(doc.buy, 0);
    assert.equal(doc.bet, 0.88);
    assert.equal(doc.mul, 5);
    assert.deepEqual(doc.rtp, [0, 100, 500]);
    assert.equal(doc.data.freeChoiceOptionIndex, 0);
    assert.deepEqual(doc.data.freeChoiceSteps, []);
    assert.deepEqual(doc.data.captureSampleGroups, ['base']);
    assert.equal(doc.data.captureSource, AG_CAPTURE_SOURCE);
    assert.equal(doc.data.captureVersion, AG_CAPTURE_VERSION);
    assert.equal(typeof doc.data.capturedAt, 'string');
});

test('insertMongoDocWithRetry preserves the same document id across transient retries', async () => {
    const doc = buildMongoDoc({
        isFeature: false,
        optionIndex: 0,
        optionCount: 0,
        bet: 1,
        win: 0,
        data: {},
    }, [0]);
    const ids: string[] = [];
    let calls = 0;

    await insertMongoDocWithRetry(async (value) => {
        calls += 1;
        ids.push(String(value._id));
        if (calls < 3) {
            throw new Error('connection closed');
        }
    }, doc, 3, 0);

    assert.equal(calls, 3);
    assert.equal(new Set(ids).size, 1);
});

test('insertMongoDocWithRetry treats duplicate id after an uncertain write as success', async () => {
    const doc = buildMongoDoc({
        isFeature: false,
        optionIndex: 0,
        optionCount: 0,
        bet: 1,
        win: 0,
        data: {},
    }, [0]);

    await assert.doesNotReject(() => insertMongoDocWithRetry(async () => {
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
    }, doc, 3, 0));
});

test('buildMongoDoc rejects incomplete rounds without a positive bet', () => {
    const round: AGCompletedRound = {
        isFeature: false,
        optionIndex: 0,
        optionCount: 0,
        bet: 0,
        win: 1,
        data: { PlayerBalanceInfo: { wager: '0' } },
    };

    assert.throws(() => buildMongoDoc(round, [0]), /invalid AG bet value/);
});

test('canAcquireGameLease allows only missing, expired, or same-owner leases', () => {
    const now = new Date('2026-07-09T10:00:00.000Z');

    assert.equal(canAcquireGameLease(null, 'pc-a', now), true);
    assert.equal(
        canAcquireGameLease({ ownerId: 'pc-b', expiresAt: new Date('2026-07-09T09:59:59.000Z') }, 'pc-a', now),
        true,
    );
    assert.equal(
        canAcquireGameLease({ ownerId: 'pc-a', expiresAt: new Date('2026-07-09T10:05:00.000Z') }, 'pc-a', now),
        true,
    );
    assert.equal(
        canAcquireGameLease({ ownerId: 'pc-b', expiresAt: new Date('2026-07-09T10:05:00.000Z') }, 'pc-a', now),
        false,
    );
});

test('worker lease ids remain isolated and reject unsafe values', () => {
    assert.equal(normalizeLeaseId('gh_123_7'), 'gh_123_7');
    assert.throws(() => normalizeLeaseId('../bad'), /invalid capture lease id/);
    assert.throws(() => normalizeLeaseId(''), /invalid capture lease id/);
});

test('buildMongoDoc records campaign metadata supplied by the runner', () => {
    const previousCampaign = process.env.CAPTURE_CAMPAIGN_ID;
    const previousWorker = process.env.CAPTURE_WORKER_INDEX;
    process.env.CAPTURE_CAMPAIGN_ID = '12345';
    process.env.CAPTURE_WORKER_INDEX = '7';
    try {
        const doc = buildMongoDoc({
            isFeature: false,
            optionIndex: 0,
            optionCount: 0,
            bet: 1,
            win: 0,
            data: {},
        }, [0]);
        assert.equal(doc.data.captureCampaignId, '12345');
        assert.equal(doc.data.captureWorkerIndex, 7);
    } finally {
        if (previousCampaign === undefined) delete process.env.CAPTURE_CAMPAIGN_ID;
        else process.env.CAPTURE_CAMPAIGN_ID = previousCampaign;
        if (previousWorker === undefined) delete process.env.CAPTURE_WORKER_INDEX;
        else process.env.CAPTURE_WORKER_INDEX = previousWorker;
    }
});

test('real data filter excludes tagged and legacy synthetic seed rows', () => {
    assert.deepEqual(realDataFilter(), { $nor: AG_SYNTHETIC_DATA_CONDITIONS });
    assert.equal(AG_SYNTHETIC_DATA_CONDITIONS[0]['data.captureSource'], 'synthetic-seed');
    assert.equal(Array.isArray(AG_SYNTHETIC_DATA_CONDITIONS[1].$and), true);
});

test('validateCompletedRound accepts a reconciled real round', () => {
    const round: AGCompletedRound = {
        isFeature: true,
        optionIndex: 0,
        optionCount: 0,
        bet: 2,
        win: 0.4,
        balance: 1877.2,
        data: {
            roundTrigger: { NextActionInfo: { nextAction: 'CASCADE_SPIN' } },
            PlayerBalanceInfo: {
                preWagerBalance: 1878.8,
                wager: 2,
                resultAmount: 0.4,
                balance: 1877.2,
            },
            roundEvents: ['Spin', 'Cascade'],
            captureSampleGroups: ['base'],
            winResolution: {
                method: 'balance-delta',
                protocolWin: 0,
                balanceDerivedWin: 0.4,
            },
        },
    };

    assert.doesNotThrow(() => validateCompletedRound(round));
});

test('validateCompletedRound rejects a zero multiplier when the balance proves a win', () => {
    const round: AGCompletedRound = {
        isFeature: false,
        optionIndex: 0,
        optionCount: 0,
        bet: 2,
        win: 0,
        balance: 2214,
        data: {
            roundTrigger: { NextActionInfo: { nextAction: 'JACKPOT_PLAY' } },
            PlayerBalanceInfo: {
                preWagerBalance: 2186,
                wager: 2,
                resultAmount: 0,
                balance: 2214,
            },
            roundEvents: ['play', 'jackpotplay'],
            captureSampleGroups: ['base'],
            winResolution: {
                method: 'protocol',
                protocolWin: 0,
                balanceDerivedWin: null,
            },
        },
    };

    assert.throws(() => validateCompletedRound(round), /balance delta 30 does not match win 0/);
});

test('validateCompletedRound rejects incomplete audit metadata', () => {
    const round: AGCompletedRound = {
        isFeature: false,
        optionIndex: 0,
        optionCount: 0,
        bet: 1,
        win: 0,
        data: { PlayerBalanceInfo: { resultAmount: 0 } },
    };

    assert.throws(() => validateCompletedRound(round), /missing roundEvents/);
});

test('validateCompletedRound rejects a completed round without its original trigger response', () => {
    const round: AGCompletedRound = {
        isFeature: true,
        optionIndex: 1,
        optionCount: 2,
        bet: 1,
        win: 0,
        data: {
            PlayerBalanceInfo: { resultAmount: 0 },
            roundEvents: ['Spin', 'pick'],
            captureSampleGroups: ['choice:1'],
            winResolution: { method: 'protocol', protocolWin: 0, balanceDerivedWin: null },
        },
    };

    assert.throws(() => validateCompletedRound(round), /missing roundTrigger/);
});
