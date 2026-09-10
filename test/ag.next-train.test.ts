import test from 'node:test';
import assert from 'node:assert/strict';
import { RoxorCometDSession } from '../src/ag.client';
import { isDeterministicCaptureError } from '../src/ag.scheduler';
import { captureAGRound, AGInitialSpinRuntimeError } from '../src/ag.round';

function trainSession(failure?: string) {
    const session = new RoxorCometDSession({ gameId: 'play-cash-express-legend-joyful-panda', name: 'Joyful Panda' });
    const calls: Array<{ event: string; parameters: Record<string, any> | null }> = [];
    const trigger = {
        PlayerBalanceInfo: { wager: 0.02, preWagerBalance: 100, resultAmount: 0, balance: 99.98 },
        NextActionInfo: { nextAction: 'NEXT_TRAIN' },
        TrainBonusSummaryInfo: { marker: 'original-trigger' },
    };
    session.callGameData = async (event, parameters) => {
        calls.push(structuredClone({ event, parameters }));
        if (calls.length === 1) { assert.equal(event, 'Spin'); return trigger; }
        assert.equal(event, 'nexttrain');
        assert.deepEqual(parameters, {});
        if (failure) throw new Error(failure);
        return {
            PlayerBalanceInfo: { resultAmount: calls.length === 3 ? 1 : 0, balance: calls.length === 3 ? 100.98 : 99.98 },
            NextActionInfo: { nextAction: calls.length === 3 ? 'SPIN' : 'NEXT_TRAIN' },
        };
    };
    session.getLastGameRequest = () => calls[calls.length - 1];
    return { session, calls, trigger };
}

test('NEXT_TRAIN 使用官方空参数连续完成两步，保留原始触发与实际请求', async () => {
    const { session, calls, trigger } = trainSession();
    const round = await captureAGRound(session);
    assert.deepEqual(calls.map(c => c.event), ['Spin', 'nexttrain', 'nexttrain']);
    assert.equal(round.bet, 0.02);
    assert.equal(round.win, 1);
    assert.equal(round.isFeature, true);
    assert.deepEqual(round.data.roundTrigger, trigger);
    assert.deepEqual(round.data.roundRequest, calls[0]);
    assert.deepEqual(round.data.roundEvents, calls.map(c => c.event));
    assert.deepEqual(round.data.freeChoiceSteps.map((s: any) => ({ action: s.action, event: s.event, parameters: s.parameters })), [
        { action: 'NEXT_TRAIN', event: 'nexttrain', parameters: {} },
        { action: 'NEXT_TRAIN', event: 'nexttrain', parameters: {} },
    ]);
});

for (const type of ['MalformedRequest', 'RuntimeError']) {
    test('NEXT_TRAIN ' + type + ' 致命失败，不重新 Spin 或包装为初始 Spin 错误', async () => {
        const { session, calls } = trainSession(JSON.stringify({ type }));
        await assert.rejects(captureAGRound(session), (error: unknown) => error instanceof Error
            && !(error instanceof AGInitialSpinRuntimeError) && error.message.includes(type)
            && isDeterministicCaptureError(error));
        assert.deepEqual(calls.map(c => c.event), ['Spin', 'nexttrain']);
    });
}
