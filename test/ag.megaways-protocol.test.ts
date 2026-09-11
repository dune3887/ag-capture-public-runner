import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession, MEGAWAYS_AUTOPLAY_ONLY_EVENTS} from '../src/ag.client';
import {captureAGRound} from '../src/ag.round';

const megaways = () => new RoxorCometDSession({
    gameId: 'play-tiki-totems-megaways',
    name: 'Tiki Totems Megaways',
    backendArtifactId: 'rgp-game-tiki-totem-megaways',
});

// 生产路径上同一事件会出现多种拼写：ag.round.ts 的事件映射把 FREE_SPIN 映射为 freeSpin，
// 协商别名还会出现 freespin / FreeSpins / freespincascade 等。全部必须命中特判。
const AUTOPLAY_ONLY_SPELLINGS = [
    'Cascade', 'cascade', 'FreeCascade', 'freecascade', 'freespincascade',
    'FreeSpin', 'freeSpin', 'freespin', 'FreeSpins', 'freespins',
];

test('Tiki Totems Megaways：Cascade/FreeCascade/FreeSpin 的任一拼写都只带 autoplay（官方前端 2.0.15）', () => {
    for (const event of AUTOPLAY_ONLY_SPELLINGS) {
        assert.equal(MEGAWAYS_AUTOPLAY_ONLY_EVENTS.has(event.trim().toLowerCase()), true,
            `${event} 应命中小写归一化白名单`);
        const params = megaways().getActionParams('CASCADE_SPIN', event) as Record<string, any>;
        assert.deepEqual(params, {autoplay: 'false'}, `${event} 参数必须与官方协议一致`);
        assert.equal('coinSize' in params, false, `${event} 不得携带 coinSize`);
        assert.equal('numberOfCoins' in params, false, `${event} 不得携带 numberOfCoins`);
        assert.equal('autoPlay' in params, false, '必须是小写 autoplay，不能混用 autoPlay');
    }
});

test('Tiki Totems Megaways：Spin 与未被官方核对的玩法事件不受特判影响', () => {
    for (const event of ['Spin', 'spin']) {
        const params = megaways().getActionParams('SPIN', event) as Record<string, any>;
        assert.ok('coinSize' in params && 'numberOfCoins' in params, `${event} 必须保留投注字段`);
    }
    for (const event of ['rewardSpin', 'RewardSpin', 'Pick']) {
        const params = megaways().getActionParams('REWARD_SPIN', event) as Record<string, any>;
        assert.ok('coinSize' in params && 'numberOfCoins' in params,
            `${event} 未经官方协议核对，不应套用特判`);
    }
});

test('其他游戏的同名事件不受影响（无回归）', () => {
    const other = new RoxorCometDSession({gameId: 'play-more-chilli', name: 'More Chilli'});
    for (const event of ['Cascade', 'FreeCascade', 'freeSpin']) {
        const params = other.getActionParams('CASCADE_SPIN', event) as Record<string, any>;
        assert.ok('coinSize' in params && 'numberOfCoins' in params,
            `非该 artifact 的 ${event} 仍按原逻辑带投注字段`);
    }
});

// 端到端用例：桥接真实会话到真实 captureAGRound，覆盖"协商别名 sticky"这一实际触发路径
// （只测单函数会漏掉 freeSpin/freespin 这类大小写与别名差异）。
test('端到端：整局中每个 Cascade/FreeCascade/FreeSpin 请求都只带 autoplay', async () => {
    const real = megaways();
    const seen: Array<{event: string; params: Record<string, any>}> = [];
    const nextAction: Record<string, string> = {
        Spin: 'FREE_SPIN',
        freeSpin: 'FREE_CASCADE', freespin: 'FREE_CASCADE', freeSpins: 'FREE_CASCADE',
        FreeSpin: 'FREE_CASCADE', FreeSpins: 'FREE_CASCADE',
        FreeCascade: 'CASCADE_SPIN', freecascade: 'CASCADE_SPIN', freespincascade: 'CASCADE_SPIN',
        Cascade: 'WAGER', cascade: 'WAGER',
    };
    const session = {
        getSpinParams: () => real.getSpinParams(),
        getPickParams: () => ({}),
        getFallbackBet: () => 0.02,
        getInitialRoundRequest: () => ({event: 'wager', parameters: {coinSize: '0.01', numberOfCoins: '1'}}),
        getActionParams: real.getActionParams.bind(real),
        isRoundTerminalAction: (action: string) => String(action).toUpperCase() === 'WAGER',
        callGameData: async (event: string, params: Record<string, any> | null) => {
            seen.push({event, params: (params || {}) as Record<string, any>});
            if (event === 'wager') {
                return {PlayerBalanceInfo: {wager: 0.02}, NextActionInfo: {nextAction: 'SPIN'}};
            }
            if (!nextAction[event]) throw new Error('unexpected event ' + event);
            return {
                PlayerBalanceInfo: {resultAmount: 0.1, balance: 100.08},
                NextActionInfo: {nextAction: nextAction[event]},
            };
        },
    };
    const round = await captureAGRound(session as any);
    const followUps = seen.filter((call) => call.event !== 'wager' && call.event !== 'Spin');
    assert.ok(followUps.length >= 2, `至少应发出 FreeSpin 与 FreeCascade/Cascade 请求，实际=${JSON.stringify(seen)}`);
    for (const call of followUps) {
        assert.deepEqual(call.params, {autoplay: 'false'},
            `${call.event} 请求不得带投注字段，实际=${JSON.stringify(call.params)}`);
    }
    assert.equal(round.isFeature, true, '整局应被判定为含玩法局');
});
