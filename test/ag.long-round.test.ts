import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMongoDoc, validateReplaySequence } from '../src/ag.mongo';
import { isDeterministicCaptureError } from '../src/ag.scheduler';
import {
    AGDiscardedRoundError,
    AGInitialSpinResponseError,
    captureAGRound,
    featureProgressKey,
    isFreeFeatureAction,
} from '../src/ag.round';

// 官方 Phoenix Gold 1.0.7 的免费玩法会给出 FreeSpinsInfo（免费转计数、累计赢奖）与 CascadeInfo，
// 这些计数会随每次免费转/级联推进；下面的 mock 按官方语义推进，用于区分「合法长局」与「原地打转」。
const freeSpinFrame = (played: number, remaining: number, accumulativeWin: number) => ({
    NextActionInfo: { nextAction: 'FREE_SPIN' },
    PlayerBalanceInfo: { balance: 100, resultAmount: 0 },
    FreeSpinsInfo: { freeSpinsPlayed: played, freeSpinsRemaining: remaining, accumulativeWin },
});

function longFreeRoundSession(followUps: number) {
    const calls: string[] = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.01,
        callGameData: async (event: string) => {
            calls.push(event);
            if (calls.length === 1) {
                return { ...freeSpinFrame(0, followUps, 0), PlayerBalanceInfo: { wager: 0.01, balance: 100, resultAmount: 0 } };
            }
            const played = calls.length - 1;
            if (played <= followUps) return freeSpinFrame(played, followUps - played, played * 0.01);
            return {
                NextActionInfo: { nextAction: 'SPIN' },
                PlayerBalanceInfo: { wager: 0.01, balance: 100 + followUps * 0.01, resultAmount: followUps * 0.01 },
            };
        },
    };
    return { session, calls };
}

test('合法免费玩法长局可超过 300 次后续请求并完整收尾', async () => {
    const { session, calls } = longFreeRoundSession(320);

    const round = await captureAGRound(session);

    assert.equal(calls.length, 322, '起手 1 次 + 320 次免费转 + 1 次终局');
    assert.equal(round.data.freeChoiceSteps.length, 321);
    assert.equal(round.data.roundTerminalAction, 'SPIN');
    assert.equal(round.isFeature, true);
    assert.doesNotThrow(() => validateReplaySequence(round.data));
    const doc = buildMongoDoc(round);
    assert.equal(Number(doc.data.roundWin), round.win);
    assert.equal(round.win, 3.2);
});

test('免费玩法阶段计数不推进的原地打转会被有界中止并留脱敏诊断', async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (line: string) => { logged.push(String(line)); });
    const calls: string[] = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.01,
        callGameData: async (event: string) => {
            calls.push(event);
            if (calls.length === 1) {
                return { ...freeSpinFrame(0, 5, 0), sessionId: 'SESSION-SECRET-ABC123' };
            }
            // 计数、累计赢奖、余额、级联结构全程不变：这是循环，不是推进中的长局。
            return { ...freeSpinFrame(0, 5, 0), PlayerBalanceInfo: { balance: 987654, wager: 0.01321, resultAmount: 4242 }, sessionId: 'SESSION-SECRET-ABC123' };
        },
    };

    await assert.rejects(captureAGRound(session, { maxSteps: 5, stallWindow: 20 }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /without progress/);
        assert.match(error.message, /responseFieldNames/);
        // 脱敏：mock 里出现的数值与会话标识都不得出现在报错或诊断里。
        for (const secret of ['987654', '0.01321', '4242', 'SESSION-SECRET-ABC123']) {
            assert.equal(error.message.includes(secret), false, `不应泄漏 ${secret}`);
        }
        return true;
    });
    assert.equal(calls.length, 22, '起手 1 次 + 21 次后续请求后判定无进展');

    const diagnostic = logged.find((line) => line.startsWith('[AG-LONG-ROUND]'));
    assert.ok(diagnostic, '长局中止必须写出脱敏诊断');
    const parsed = JSON.parse(diagnostic.slice('[AG-LONG-ROUND] '.length));
    assert.deepEqual(Object.keys(parsed).sort(), ['actions', 'cascadeInfo', 'events', 'freeSpinsInfo', 'responseFieldNames', 'steps']);
    assert.deepEqual(parsed.actions, ['FREE_SPIN']);
    assert.equal(parsed.freeSpinsInfo, true);
    for (const secret of ['987654', '0.01321', '4242', 'SESSION-SECRET-ABC123']) {
        assert.equal(diagnostic.includes(secret), false, `诊断不应泄漏 ${secret}`);
    }
});

test('免费玩法阶段计数整体不变但玩法仍在推进的合法长局不会被误杀', async () => {
    // 审查提出的假阳性场景：单次免费转内含上百次级联，四个计数在整段不变。
    // 现实现只在 FreeSpinsInfo 存在时计数，且 stallWindow 夹紧到不小于基础上限，
    // 因此这种合法长局不会比旧行为更早被截断。
    const cascades = 210;
    const calls: string[] = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.01,
        callGameData: async () => {
            calls.push('c');
            if (calls.length === 1) {
                return { ...freeSpinFrame(0, 1, 0), PlayerBalanceInfo: { wager: 0.01, balance: 100, resultAmount: 0 }, CascadeInfo: { cascadeSymbolsData: { symbolChangeDatas: [1, 2, 3] } } };
            }
            if (calls.length <= cascades + 1) {
                return { ...freeSpinFrame(0, 1, 0), CascadeInfo: { cascadeSymbolsData: { symbolChangeDatas: [1, 2, 3] } } };
            }
            return { NextActionInfo: { nextAction: 'SPIN' }, PlayerBalanceInfo: { wager: 0.01, balance: 100, resultAmount: 0 } };
        },
    };

    const round = await captureAGRound(session);

    assert.equal(round.data.roundTerminalAction, 'SPIN');
    assert.equal(round.data.freeChoiceSteps.length, cascades + 1, '210 次级联 + 1 次终局都要被记录');
    assert.doesNotThrow(() => validateReplaySequence(round.data));
});

test('含 FREE 字样的选择态不会把上限放宽到免费玩法档位', async () => {
    const calls: string[] = [];
    const session = {
        getSpinParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex }),
        getFallbackBet: () => 1,
        callGameData: async () => {
            calls.push('PICK_FREE_SPINS');
            return {
                NextActionInfo: { nextAction: 'PICK_FREE_SPINS' },
                PlayerBalanceInfo: { wager: 1, balance: 100, resultAmount: 0 },
            };
        },
    };

    await assert.rejects(
        captureAGRound(session, { maxSteps: 5, featureMaxSteps: 12 }),
        /exceeded 5 follow-up steps/,
    );
    assert.equal(calls.length, 6, 'PICK_FREE_SPINS 不是免费转动作，仍应按基础 5 步触顶');
});

test('起手响应即处于免费玩法时按长局档位放行（避免遗漏起手信号）', async () => {
    const calls: string[] = [];
    const session = {
        getSpinParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex }),
        getFallbackBet: () => 1,
        callGameData: async () => {
            calls.push('c');
            if (calls.length === 1) {
                return {
                    NextActionInfo: { nextAction: 'FREE_SPIN' },
                    PlayerBalanceInfo: { wager: 1, balance: 100, resultAmount: 0 },
                };
            }
            if (calls.length <= 7) {
                // 后续响应都不带 FreeSpinsInfo、动作名也不含 FREE：只能靠起手信号判定。
                return { NextActionInfo: { nextAction: 'CASCADE_SPIN' }, PlayerBalanceInfo: { balance: 100, resultAmount: 0 } };
            }
            return { NextActionInfo: { nextAction: 'SPIN' }, PlayerBalanceInfo: { balance: 100, resultAmount: 0 } };
        },
    };

    const round = await captureAGRound(session, { maxSteps: 5, featureMaxSteps: 9 });

    // 起手 1 次 + 6 次 CASCADE_SPIN 后续 + 1 次终局 = 8 次；若起手信号被漏判，会在第 6 次（基础 5 步）就抛错。
    assert.equal(calls.length, 8, '起手信号必须计入免费玩法判定，否则会在基础 5 步处被截断');
    assert.equal(round.data.roundTerminalAction, 'SPIN');
});

test('未进入免费玩法的回合仍受 300 步基础上限保护', async () => {
    const calls: string[] = [];
    const session = {
        getSpinParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex }),
        getFallbackBet: () => 1,
        callGameData: async () => {
            calls.push('CASCADE_SPIN');
            return {
                NextActionInfo: { nextAction: 'CASCADE_SPIN' },
                PlayerBalanceInfo: { wager: 1, balance: 100, resultAmount: 0 },
            };
        },
    };

    await assert.rejects(captureAGRound(session, { maxSteps: 5 }), /exceeded 5 follow-up steps/);
    assert.equal(calls.length, 6, '起手 1 次 + 5 次后续请求后触顶');
});

test('长局中止保持确定性分类，不退化到 error-only 或普通网络重试', () => {
    assert.equal(isDeterministicCaptureError(new Error('AG round exceeded 300 follow-up steps {"steps":300}')), true);
    assert.equal(isDeterministicCaptureError(new Error('AG round exceeded 200 follow-up steps without progress {"steps":220}')), true);
    assert.equal(isDeterministicCaptureError(new AGDiscardedRoundError('FreeSpin')), false);
    assert.equal(isDeterministicCaptureError(new AGInitialSpinResponseError('error-only')), false);
    assert.equal(isDeterministicCaptureError(new Error('read ECONNRESET')), false);
});

test('进展指纹只取会推进的计数，缺少官方免费玩法字段时为 null', () => {
    assert.equal(featureProgressKey({ NextActionInfo: { nextAction: 'FREE_SPIN' } }), null);
    const base = {
        FreeSpinsInfo: { freeSpinsPlayed: 1, freeSpinsRemaining: 4, accumulativeWin: 0.5 },
        PlayerBalanceInfo: { balance: 100 },
        CascadeInfo: { cascadeSymbolsData: { symbolChangeDatas: [1, 2] } },
    };
    const baseKey = featureProgressKey(base);
    assert.ok(baseKey, '带 FreeSpinsInfo 时必须给出指纹');
    // 五个维度里任意一个推进都必须改变指纹，否则 stall 判定会把推进中的长局当循环。
    const advanced = [
        { ...base, FreeSpinsInfo: { freeSpinsPlayed: 2, freeSpinsRemaining: 3, accumulativeWin: 0.5 } },
        { ...base, FreeSpinsInfo: { freeSpinsPlayed: 1, freeSpinsRemaining: 3, accumulativeWin: 0.5 } },
        { ...base, FreeSpinsInfo: { freeSpinsPlayed: 1, freeSpinsRemaining: 4, accumulativeWin: 0.6 } },
        { ...base, PlayerBalanceInfo: { balance: 101 } },
        { ...base, CascadeInfo: { cascadeSymbolsData: { symbolChangeDatas: [1, 2, 3] } } },
    ];
    for (const variant of advanced) {
        assert.notEqual(featureProgressKey(variant), baseKey);
    }
});

test('免费玩法动作白名单只放行真正的免费转/级联，不含 FREE 字样的选择态', () => {
    for (const action of ['FREE_SPIN', 'FREE_CASCADE', 'MORE_CHILLI_FREE_SPIN', 'FREE_FEATURE', 'freeSpin']) {
        assert.equal(isFreeFeatureAction(action), true, action);
    }
    for (const action of ['PICK_FREE_SPINS', 'PICK', 'CASCADE_SPIN', 'SPIN', '', undefined]) {
        assert.equal(isFreeFeatureAction(action), false, String(action));
    }
});
