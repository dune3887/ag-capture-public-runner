// 第 4 步诊断（2026-09-12）落地修复的协议测试：
// 四款游戏的官方前端 bundle 已逐字核对（证据 .controller/blocked-games-diagnosis.json，私有仓库）：
//  - Secrets of the Queen Classic 1.0.0：LOCK_SPIN → 小写 lockspin，带 {coinSize,numberOfCoins}
//  - Lucky88 2.0.1：DICE_SPIN → 小写 dicespin，载荷为空 {}
//  - Secrets of the Phoenix Megaways 2.0.8：Cascade/FreeCascade/FreeSpin 只带 autoplay（与 Tiki 2.0.15 同构）
//  - Secrets of the Phoenix Elements 3.4.0：只有 spin 带投注字段，其余裸发；pick/freepick 只带 pickIndex
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoxorCometDSession } from '../src/ag.client';
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
