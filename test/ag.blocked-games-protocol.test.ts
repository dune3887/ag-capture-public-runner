// 第 4 步诊断（2026-09-12）落地修复的协议测试：
// 四款游戏的官方前端 bundle 已逐字核对（证据 .controller/blocked-games-diagnosis.json，私有仓库）：
//  - Secrets of the Queen Classic 1.0.0：LOCK_SPIN → 小写 lockspin，带 {coinSize,numberOfCoins}
//  - Lucky88 2.0.1：DICE_SPIN → 小写 dicespin，载荷为空 {}
//  - Secrets of the Phoenix Megaways 2.0.8：Cascade/FreeCascade/FreeSpin 只带 autoplay（与 Tiki 2.0.15 同构）
//  - Secrets of the Phoenix Elements 3.4.0：只有 spin 带投注字段，其余裸发；pick/freepick 只带 pickIndex
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoxorCometDSession, parseResponseText } from '../src/ag.client';
import { captureAGRound } from '../src/ag.round';

const sessionOf = (gameId: string, name: string, backendArtifactId: string) =>
    new RoxorCometDSession({ gameId, name, backendArtifactId });

const queen = () => sessionOf('play-secrets-of-the-queen', 'Secrets of the Queen', 'rgp-game-secrets-of-the-queen-classic');
const lucky88 = () => sessionOf('play-lucky88', 'Lucky 88', 'rgp-game-lucky88');
const phoenixMegaways = () => sessionOf('play-phoenix-megaways', 'Secrets of the Phoenix Megaways', 'rgp-game-secrets-of-the-phoenix-megaways');
const elements = () => sessionOf('play-phoenix-elements', 'Secrets of the Phoenix Elements', 'rgp-game-phoenix-mega-match');

test('Secrets of the Phoenix Megaways：Cascade/FreeCascade/FreeSpin 只带 autoplay（官方前端 2.0.8）', () => {
    for (const event of ['Cascade', 'cascade', 'FreeCascade', 'freecascade', 'FreeSpin', 'freespin', 'FreeSpins']) {
        const params = phoenixMegaways().getActionParams('CASCADE_SPIN', event) as Record<string, any>;
        assert.deepEqual(params, { autoplay: 'false' }, `${event} 参数必须与官方协议一致`);
        assert.equal('coinSize' in params, false);
        assert.equal('numberOfCoins' in params, false);
    }
    // Spin 不受特判影响，保留投注字段。
    const spin = phoenixMegaways().getActionParams('SPIN', 'Spin') as Record<string, any>;
    assert.ok('coinSize' in spin && 'numberOfCoins' in spin, 'Spin 必须保留投注字段');
});

test('Secrets of the Phoenix Elements：非 spin 事件一律裸发（官方前端 3.4.0）', () => {
    for (const [action, event] of [['CASCADE', 'Cascade'], ['FREE_CASCADE', 'FreeCascade'],
        ['FREE_FEATURE', 'freefeature'], ['FREE_SPIN', 'freespin'], ['FREE_SPIN', 'FreeSpin'],
        ['FEATURE', 'feature']] as const) {
        const params = elements().getActionParams(action, event) as Record<string, any>;
        assert.deepEqual(params, {}, `${event} 必须裸发`);
    }
    const spin = elements().getActionParams('SPIN', 'Spin') as Record<string, any>;
    assert.ok('coinSize' in spin && 'numberOfCoins' in spin, 'Spin 必须保留投注字段');
    // pick/freepick 只带字符串 pickIndex。
    for (const index of [0, 1, '2']) {
        assert.deepEqual(elements().getPickParams(index), { pickIndex: String(index) });
    }
});

test('Elements 特判不影响其他 artifact：More Chilli 的 follow-up 仍带投注字段（无回归）', () => {
    const other = sessionOf('play-more-chilli', 'More Chilli', '');
    const params = other.getActionParams('CASCADE', 'Cascade') as Record<string, any>;
    assert.ok('coinSize' in params && 'numberOfCoins' in params);
});

test('Secrets of the Queen：LOCK_SPIN 映射为小写 lockspin 并保留投注字段（官方前端 1.0.0）', async () => {
    const real = queen();
    const seen: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => real.getSpinParams(),
        getPickParams: (index: number | string) => real.getPickParams(index),
        getFallbackBet: () => 0.01,
        getInitialRoundRequest: () => ({ event: 'wager', parameters: { coinSize: '0.01', numberOfCoins: '1' } }),
        getActionParams: real.getActionParams.bind(real),
        isRoundTerminalAction: (action: string) => String(action).toUpperCase() === 'WAGER',
        callGameData: async (event: string, params: Record<string, any> | null) => {
            seen.push({ event, params });
            if (event === 'wager') {
                return { PlayerBalanceInfo: { wager: 0.01 }, NextActionInfo: { nextAction: 'SPIN' } };
            }
            if (event === 'Spin') {
                return { PlayerBalanceInfo: { resultAmount: 0.2, balance: 100 }, NextActionInfo: { nextAction: 'LOCK_SPIN' } };
            }
            if (event === 'lockspin') {
                return { PlayerBalanceInfo: { resultAmount: 0.1, balance: 100 }, NextActionInfo: { nextAction: 'WAGER' } };
            }
            throw new Error('unexpected event ' + event);
        },
    };

    await captureAGRound(session as never);

    assert.deepEqual(seen.map(e => e.event), ['wager', 'Spin', 'lockspin']);
    const lockParams = (seen[2].params || {}) as Record<string, any>;
    assert.ok('coinSize' in lockParams && 'numberOfCoins' in lockParams, 'lockspin 与官方一致须携带投注字段');
});

test('Lucky88：DICE_SPIN 映射为小写 dicespin 且载荷为空（官方前端 2.0.1）', async () => {
    const real = lucky88();
    const seen: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => real.getSpinParams(),
        getPickParams: (index: number | string) => real.getPickParams(index),
        getFallbackBet: () => 0.01,
        getInitialRoundRequest: () => ({ event: 'wager', parameters: { coinSize: '0.01', numberOfCoins: '1' } }),
        getActionParams: real.getActionParams.bind(real),
        isRoundTerminalAction: (action: string) => String(action).toUpperCase() === 'WAGER',
        callGameData: async (event: string, params: Record<string, any> | null) => {
            seen.push({ event, params });
            if (event === 'wager') {
                return { PlayerBalanceInfo: { wager: 0.01 }, NextActionInfo: { nextAction: 'SPIN' } };
            }
            if (event === 'Spin') {
                return { PlayerBalanceInfo: { resultAmount: 0.5, balance: 100 }, NextActionInfo: { nextAction: 'DICE_SPIN' } };
            }
            if (event === 'dicespin') {
                return { PlayerBalanceInfo: { resultAmount: 0.1, balance: 100 }, NextActionInfo: { nextAction: 'WAGER' } };
            }
            throw new Error('unexpected event ' + event);
        },
    };

    await captureAGRound(session as never);

    assert.deepEqual(seen.map(e => e.event), ['wager', 'Spin', 'dicespin']);
    assert.deepEqual(seen[2].params, {}, 'dicespin 必须为空参数（官方 requestResponse("dicespin","{}")）');
    
});

test('Secrets of the Phoenix Hold & Gold：HOLD_AND_GOLD_SPIN 映射为官方驼峰 HoldAndGoldSpin（AG-REJECT 实证小写被拒）', async () => {
    const real = sessionOf('play-secrets-of-the-phoenix-hold-and-gold', 'Secrets of the Phoenix Hold & Gold', 'rgp-game-secrets-of-the-phoenix-hold-and-gold');
    const seen: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => real.getSpinParams(),
        getPickParams: (index: number | string) => real.getPickParams(index),
        getFallbackBet: () => 0.01,
        getInitialRoundRequest: () => ({ event: 'wager', parameters: { coinSize: '0.1', numberOfCoins: '1' } }),
        getActionParams: real.getActionParams.bind(real),
        isRoundTerminalAction: (action: string) => String(action).toUpperCase() === 'WAGER',
        callGameData: async (event: string, params: Record<string, any> | null) => {
            seen.push({ event, params });
            if (event === 'wager') {
                return { PlayerBalanceInfo: { wager: 0.1 }, NextActionInfo: { nextAction: 'SPIN' } };
            }
            if (event === 'Spin') {
                return { PlayerBalanceInfo: { resultAmount: 0.2, balance: 100 }, NextActionInfo: { nextAction: 'HOLD_AND_GOLD_SPIN' } };
            }
            if (event === 'HoldAndGoldSpin') {
                return { PlayerBalanceInfo: { resultAmount: 0.1, balance: 100 }, NextActionInfo: { nextAction: 'WAGER' } };
            }
            throw new Error('unexpected event ' + event);
        },
    };

    await captureAGRound(session as never);

    assert.deepEqual(seen.map(e => e.event), ['wager', 'Spin', 'HoldAndGoldSpin']);
    const hngParams = (seen[2].params || {}) as Record<string, any>;
    assert.ok('coinSize' in hngParams && 'numberOfCoins' in hngParams, 'HoldAndGoldSpin 与官方一致须携带投注字段');
});

test('Wonders of The Deep：PICK 状态走 boardPickEvent{row,column} 行优先逐格（官方 3.0.20）', async () => {
    const real = sessionOf('play-wonders-of-the-deep', 'Wonders of The Deep', 'rgp-game-sunken-treasure');
    const seen: Array<{ event: string; params: Record<string, any> | null }> = [];
    let picks = 0;
    const session = {
        getSpinParams: () => real.getSpinParams(),
        getPickParams: (index: number | string) => real.getPickParams(index),
        getPickProtocol: real.getPickProtocol.bind(real),
        getFallbackBet: () => 0.01,
        getInitialRoundRequest: () => ({ event: 'wager', parameters: { coinSize: '0.01', numberOfCoins: '1' } }),
        getActionParams: real.getActionParams.bind(real),
        isRoundTerminalAction: (action: string) => String(action).toUpperCase() === 'WAGER',
        callGameData: async (event: string, params: Record<string, any> | null) => {
            seen.push({ event, params });
            if (event === 'wager') {
                return { PlayerBalanceInfo: { wager: 0.01 }, NextActionInfo: { nextAction: 'SPIN' } };
            }
            if (event === 'Spin') {
                return { PlayerBalanceInfo: { resultAmount: 0.2, balance: 100 }, NextActionInfo: { nextAction: 'PICK' },
                    PickGameInfo: { requestMode: 'legacy-stateful-spin-pick', pickOptions: [] } };
            }
            if (event === 'boardPickEvent') {
                picks += 1;
                if (picks < 3) {
                    return { PlayerBalanceInfo: { resultAmount: 0.1, balance: 100 }, NextActionInfo: { nextAction: 'PICK' } };
                }
                return { PlayerBalanceInfo: { resultAmount: 0.3, balance: 100 }, NextActionInfo: { nextAction: 'WAGER' } };
            }
            throw new Error('unexpected event ' + event);
        },
    };

    await captureAGRound(session as never);

    assert.deepEqual(seen.map(e => e.event), ['wager', 'Spin', 'boardPickEvent', 'boardPickEvent', 'boardPickEvent']);
    const pickParams = seen.filter(e => e.event === 'boardPickEvent').map(e => e.params);
    assert.deepEqual(pickParams[0], { row: '0', column: '0' });
    assert.deepEqual(pickParams[1], { row: '1', column: '0' });
    assert.deepEqual(pickParams[2], { row: '2', column: '0' });
    for (const p of pickParams) {
        assert.equal('pickIndex' in (p as Record<string, any>), false, 'boardPickEvent 不得携带 pickIndex');
    }
});

test('Wonders 特判不影响其他游戏：More Chilli 的 PICK 无 boardPickEvent 协议（无回归）', () => {
    const other = sessionOf('play-more-chilli', 'More Chilli', '');
    assert.equal(other.getPickProtocol?.('PICK', {}, []), undefined);
});

test('parseResponseText：Wonders 选板响应的 PickResultEvent.type 决定继续选板或回基础局', () => {
    const keepPicking = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<?xml version="1.0"?><Events><PlayModeEvent mode="PICK"/><PickResultEvent type="REVEAL" win="0.50"/><GameMetadataEvent/></Events>' },
    }, 'boardPickEvent');
    assert.equal(keepPicking.NextActionInfo.nextAction, 'PICK');

    const done = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<?xml version="1.0"?><Events><PlayModeEvent mode="PLAY"/><PickResultEvent type="PLAY" win="12.00"/><GameMetadataEvent/></Events>' },
    }, 'boardPickEvent');
    assert.equal(done.NextActionInfo.nextAction, 'SPIN');
});

test('parseResponseText：免费转结算响应里的 PickBonusEvent 不得被当作可操作选板（官方 D 条件）', () => {
    const settlement = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<?xml version="1.0"?><Events><PlayModeEvent/><DisplayReelsEvent><Reel id="0"><Symbol id="0" value="11"/></Reel></DisplayReelsEvent>' +
            '<UpdateFreeSpinCountEvent coinSize="0.15" freeSpinsRemaining="0" multiplier="3" winTotal="38.25"/>' +
            '<DisplayBonusEvent accumulativeFreeSpinWin="38.25" extraBonusWin="9.45" totalBonusGameWinnings="47.70"/>' +
            '<HideFreeSpinEvent/><PickBonusEvent/><EnableGameEvent/><GameMetadataEvent/></Events>' },
    }, 'freeSpin');
    assert.equal(settlement.NextActionInfo.nextAction, 'SPIN', '结算态必须回基础局 spin，不得发选板');

    const baseTrigger = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<?xml version="1.0"?><Events><PlayModeEvent/><DisplayReelsEvent><Reel id="0"><Symbol id="0" value="11"/></Reel></DisplayReelsEvent>' +
            '<DisplayWinEvent balance="1990.85" grossWin="0.00"/>' +
            '<PickBonusEvent initiatingLines="3"><InitiatingSymbols><Reel id="0"><Symbol id="0" value="11"/></Reel></InitiatingSymbols></PickBonusEvent>' +
            '<GameMetadataEvent/></Events>' },
    }, 'spin');
    assert.equal(baseTrigger.NextActionInfo.nextAction, 'PICK', '基础局触发仍须进入选板');

    const midFreeSpinRetrigger = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<?xml version="1.0"?><Events><PlayModeEvent/><UpdateFreeSpinCountEvent coinSize="0.15" freeSpinsRemaining="5" multiplier="2" winTotal="1.00"/>' +
            '<PickBonusEvent/><GameMetadataEvent/></Events>' },
    }, 'freeSpin');
    assert.equal(midFreeSpinRetrigger.NextActionInfo.nextAction, 'FREE_SPIN', '免费转未结束时仍继续免费转');
});
