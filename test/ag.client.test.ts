import { AGProviderResponseError } from '../src/ag.round';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CAPTURE_COIN_SIZE,
    buildFollowUpParams,
    buildLegacySpinParams,
    buildLowercaseFollowUpCandidates,
    buildPickParams,
    buildSpinParams,
    parseResponseText,
    resolveCaptureCoinSize,
    RoxorCometDSession,
} from '../src/ag.client';

test('Tiki 鱼奖励索引步长不影响椰子或 Fortune Temple', () => {
    const tiki=new RoxorCometDSession({gameId:'test',name:'test',backendArtifactId:'rgp-game-tiki-island'});
    const fortune=new RoxorCometDSession({gameId:'test',name:'test',backendArtifactId:'rgp-game-fortunetemple'});
    assert.equal(tiki.getSequentialPickIndex(2,{XmlEvents:{PickBonusEvent:{id:'2'}}}),6);
    assert.equal(tiki.getSequentialPickIndex(2,{XmlEvents:{PickBonusEvent:{id:'0'}}}),6);
    assert.equal(tiki.getSequentialPickIndex(2,{XmlEvents:{PickBonusEvent:{id:'1'}}}),2);
    assert.equal(fortune.getSequentialPickIndex(2,{XmlEvents:{PickBonusEvent:{id:'2'}}}),2);
});

test('lowercase follow-up protocol falls back to legacy event names and parameters', () => {
    assert.deepEqual(buildLowercaseFollowUpCandidates('Cascade', {}), [
        { event: 'cascade', parameters: {} },
        { event: 'Cascade', parameters: { autoPlay: 'false' } },
        { event: 'freespincascade', parameters: {} },
        { event: 'FreeCascade', parameters: { autoPlay: 'false' } },
    ]);
    assert.deepEqual(buildLowercaseFollowUpCandidates('FreeCascade', {}), [
        { event: 'freespincascade', parameters: {} },
        { event: 'FreeCascade', parameters: { autoPlay: 'false' } },
        { event: 'cascade', parameters: {} },
        { event: 'Cascade', parameters: { autoPlay: 'false' } },
    ]);
    assert.deepEqual(buildLowercaseFollowUpCandidates('FreeSpin', {}), [
        { event: 'freeSpin', parameters: {} },
        { event: 'FreeSpin', parameters: { autoPlay: 'false' } },
    ]);
    assert.deepEqual(buildLowercaseFollowUpCandidates('Pick', { pickIndex: '2' }), [
        { event: 'pick', parameters: { pickIndex: '2' } },
        { event: 'Pick', parameters: { pickIndex: '2' } },
    ]);
});

test('capture coin defaults to the game wagering coin size unless COIN is explicitly set', () => {
    assert.equal(CAPTURE_COIN_SIZE, process.env.COIN || '');
    assert.equal(
        resolveCaptureCoinSize(
            { gameId: 'play-test', name: 'Test', defaultCoinSize: '0.05' },
            { defaultCoinSize: 0.05, availableCoinSizes: [0.01, 0.05] },
        ),
        '0.05',
    );
});

test('spin params follow the official payload and include active symbols only when supplied', () => {
    const spinParams = buildSpinParams('0.01', '1,1,1');
    const activeSpinParams = buildSpinParams('0.01', '1,1,1', { wildSymbol: 'WILD1' });
    const followUpParams = buildFollowUpParams('0.01', '1,1,1');
    const pickParams = buildPickParams('0.01', '1,1,1', 2);

    assert.deepEqual(spinParams, { coinSize: '0.01', numberOfCoins: '1,1,1' });
    assert.deepEqual(activeSpinParams, {
        coinSize: '0.01',
        numberOfCoins: '1,1,1',
        activeSymbols: '{"wildSymbol":"WILD1"}',
    });
    assert.deepEqual(buildLegacySpinParams('0.01', '1,1'), {
        autoPlay: 'false',
        coinSize: '0.01',
        numberOfCoins: '1,1',
    });
    assert.deepEqual(followUpParams, {
        coinSize: '0.01',
        numberOfCoins: '1,1,1',
    });
    assert.deepEqual(pickParams, {
        coinSize: '0.01',
        numberOfCoins: '1,1,1',
        pickIndex: '2',
    });
});

test('parseResponseText maps Genesis XML handshakes instead of rejecting the root element', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<HandshakeResponse>',
                '<Handshake>',
                '<CoinSizes><CoinSize>0.01</CoinSize><CoinSize>0.04</CoinSize></CoinSizes>',
                '<DefaultCoinSize>0.04</DefaultCoinSize>',
                '<AvailableBets>25</AvailableBets>',
                '<CurrentBets>25</CurrentBets>',
                '<NextSpinState><GameState>InBaseGame</GameState></NextSpinState>',
                '</Handshake>',
                '</HandshakeResponse>',
            ].join(''),
        },
    }, 'Handshake');

    assert.equal(data.AGProtocolInfo.format, 'genesis-xml');
    assert.equal(data.GameWageringInfo.currentCoinSize, 0.04);
    assert.equal(data.GameWageringInfo.currentBets.length, 25);
    assert.deepEqual(data.GameWageringInfo.availableCoinSizes, [0.01, 0.04]);
    assert.equal(data.NextActionInfo.nextAction, 'SPIN');
});

test('parseResponseText maps Genesis spin win, balance, and game reference fields', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<?xml version="1.0"?>',
                '<SpinResponse>',
                '<SpinResult><GrossWin>2.40</GrossWin><NextSpinState><GameState>InBaseGame</GameState></NextSpinState></SpinResult>',
                '<PostSpinBalance>2001.40</PostSpinBalance>',
                '<GamePlayId>round-genesis-1</GamePlayId>',
                '</SpinResponse>',
            ].join(''),
        },
    }, 'Spin');

    assert.equal(data.PlayerBalanceInfo.resultAmount, 2.4);
    assert.equal(data.PlayerBalanceInfo.balance, 2001.4);
    assert.equal(data.GameReferenceInfo.gameReference, 'round-genesis-1');
    assert.deepEqual(data.GameWageringInfo.currentBets, []);
});

test('parseResponseText treats Genesis PostFreeSpins as a completed round', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<SpinResponse>',
                '<SpinResult>',
                '<FreeSpinsRemaining>0</FreeSpinsRemaining>',
                '<NextSpinState><GameState>PostFreeSpins</GameState></NextSpinState>',
                '</SpinResult>',
                '</SpinResponse>',
            ].join(''),
        },
    }, 'FreeSpin');

    assert.equal(data.NextActionInfo.nextAction, 'SPIN');
});

test('parseResponseText maps XML handshake events into wagering data', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<Events>',
                '<SetBalanceEvent balance="2000.00"/>',
                '<SetCoinSizesEvent coinSizes="0.02,0.05,0.10" defaultCoinSize="0.10"/>',
                '<SetBetsEvent availableBets="1,1,1" coinSize="0.10" currentBets="1,1,1"/>',
                '</Events>',
            ].join(''),
        },
    }, 'Handshake');

    assert.deepEqual(data.GameWageringInfo.currentBets, [1, 1, 1]);
    assert.deepEqual(data.GameWageringInfo.availableCoinSizes, [0.02, 0.05, 0.1]);
    assert.equal(data.GameWageringInfo.defaultCoinSize, 0.1);
    assert.equal(data.PlayerBalanceInfo.balance, 2000);
});

test('parseResponseText maps XML completed spins into terminal round data', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<Events>',
                '<ShowGameReferenceEvent gameReference="round-1"/>',
                '<SetBalanceEvent balance="1999.00"/>',
                '<GameOverEvent balance="1999.00" groupId="round-1"/>',
                '</Events>',
            ].join(''),
        },
    }, 'Spin');

    assert.equal(data.GameReferenceInfo.gameReference, 'round-1');
    assert.equal(data.PlayerBalanceInfo.balance, 1999);
    assert.equal(data.PlayerBalanceInfo.resultAmount, 0);
    assert.equal(data.GameSlotResultInfo.grossWin, 0);
    assert.equal(data.NextActionInfo.nextAction, 'SPIN');
});

test('parseResponseText maps XML cascade state and gross win without ending the round', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<ShowGameReferenceEvent gameReference="cascade-round-1"/>',
                '<SetBalanceEvent balance="1995.00"/>',
                '<ShowWinEvent grossWin="0.90"/>',
                '<CountUpBalanceEvent from="1995.00" to="1995.90"/>',
                '<EnableCascadeEvent/>',
                '</Events>',
            ].join(''),
        },
    }, 'spin');

    assert.equal(data.PlayerBalanceInfo.resultAmount, 0.9);
    assert.equal(data.PlayerBalanceInfo.balance, 1995.9);
    assert.equal(data.GameSlotResultInfo.grossWin, 0.9);
    assert.equal(data.NextActionInfo.nextAction, 'CASCADE');
});

test('parseResponseText refuses to store an XML gameplay response with an unknown enable event', () => {
    assert.throws(() => parseResponseText({
        channel: '/service/game',
        data: {
            responseText: '<Events><EnableMysteryEvent/></Events>',
        },
    }, 'spin'), /XML response missing supported next action: EnableMysteryEvent/);
});

test('parseResponseText maps XML pick options to 1-based storage indexes', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<ShowPickGameEvent><PickRound optionsAvailable="2" picksRemaining="1" roundIndex="0">',
                '<PickOption pickIndex="0" state="AVAILABLE"/>',
                '<PickOption pickIndex="1" state="AVAILABLE"/>',
                '</PickRound></ShowPickGameEvent>',
                '<EnablePickGameEvent/>',
                '</Events>',
            ].join(''),
        },
    }, 'spin');

    assert.equal(data.NextActionInfo.nextAction, 'PICK');
    assert.equal(data.PickGameInfo.optionCount, 2);
    assert.deepEqual(data.PickGameInfo.pickOptions.map((option: Record<string, any>) => ({
        pickIndex: option.pickIndex,
        requestPickIndex: option.requestPickIndex,
    })), [
        { pickIndex: 1, requestPickIndex: '0' },
        { pickIndex: 2, requestPickIndex: '1' },
    ]);
});

test('parseResponseText maps legacy XML pick bonus and sequential pick item states', () => {
    const trigger = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: '<Events><PickBonusEvent id="1" initiatingLines="10" grossWin="6.50" balance="2006.30"/></Events>',
        },
    }, 'Spin');
    const nextPick = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: '<Events><PickItemEvent isLast="false"><PickItem type="WIN" value="125"/></PickItemEvent></Events>',
        },
    }, 'Pick');
    const completed = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<PickItemEvent isLast="true"><PickItem type="COLLECT" value="0"/></PickItemEvent>',
                '<PickBonusResultEvent balance="1924.60" grossWin="63.50"/>',
                '<GameOverEvent balance="1924.60"/>',
                '</Events>',
            ].join(''),
        },
    }, 'Pick');

    assert.equal(trigger.NextActionInfo.nextAction, 'PICK');
    assert.equal(trigger.PickGameInfo.requestMode, 'legacy-preloaded-pick');
    assert.equal(trigger.PickGameInfo.requestEvent, 'Pick');
    assert.equal(trigger.PlayerBalanceInfo.resultAmount, 6.5);
    assert.equal(trigger.PlayerBalanceInfo.balance, 2006.3);
    assert.equal(nextPick.NextActionInfo.nextAction, 'PICK');
    assert.equal(nextPick.PickGameInfo.requestMode, 'legacy-sequential-pick');
    assert.equal(completed.NextActionInfo.nextAction, 'SPIN');
    assert.equal(completed.PlayerBalanceInfo.resultAmount, 63.5);
    assert.equal(completed.PlayerBalanceInfo.balance, 1924.6);
});

test('parseResponseText requests Fortune Temple rounds and terminates on PickBonusResult', () => {
    const nextPick = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<PlayModeEvent mode="NORMAL"/>',
                '<PickItemEvent isLast="true"><PickItem type="WIN" value="15"/></PickItemEvent>',
                '<NextRoundEvent/>',
                '<GameMetadataEvent/>',
                '</Events>',
            ].join(''),
        },
    }, 'Pick');
    const completed = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<PickItemEvent isLast="false"><PickItem type="COLLECT" value="0"/></PickItemEvent>',
                '<DisplayWinEvent balance="2007.50" grossWin="0.00"/>',
                '<PickBonusResultEvent balance="2014.50" grossWin="7.00"/>',
                '<GameMetadataEvent/>',
                '</Events>',
            ].join(''),
        },
    }, 'Pick');

    assert.equal(nextPick.NextActionInfo.nextAction, 'NEXT_PICK_ROUND');
    assert.equal(nextPick.PickGameInfo, undefined);
    assert.equal(completed.NextActionInfo.nextAction, 'SPIN');
    assert.equal(completed.PickGameInfo, undefined);
    assert.equal(completed.PlayerBalanceInfo.resultAmount, 7);
    assert.equal(completed.PlayerBalanceInfo.balance, 2014.5);
});

test('parseResponseText keeps stateless Fortune Temple COLLECT in the next pick', () => {
    const collectPick = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<PlayModeEvent mode="NORMAL"/>',
                '<PickItemEvent isLast="true"><PickItem type="COLLECT" value="0"/></PickItemEvent>',
                '<GameMetadataEvent/>',
                '</Events>',
            ].join(''),
        },
    }, 'Pick');

    assert.equal(collectPick.NextActionInfo.nextAction, 'PICK');
    assert.equal(collectPick.PickGameInfo.requestMode, 'legacy-sequential-pick');
});

test('parseResponseText identifies Fortune Temple multi-round pick mode', () => {
    const trigger = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<Events><MultiRoundPickBonusEvent id="1"/></Events>' },
    }, 'Spin');

    assert.equal(trigger.NextActionInfo.nextAction, 'PICK');
    assert.equal(trigger.PickGameInfo.requestMode, 'legacy-multiround-pick');
});

test('parseResponseText identifies stateful Fortune Temple spin-pick multiplier', () => {
    const trigger = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<Events><PickBonusEvent id="0" initiatingLines="10,20"/></Events>' },
    }, 'Spin');

    assert.equal(trigger.PickGameInfo.requestMode, 'legacy-stateful-spin-pick');
    assert.equal(trigger.PickGameInfo.bonusMultiplier, 2);
});

test('parseResponseText enters the next Fortune Temple pick after RoundEvent', () => {
    const nextPick = parseResponseText({
        channel: '/service/game',
        data: { responseText: '<Events><RoundEvent/></Events>' },
    }, 'RoundPickEvent');

    assert.equal(nextPick.NextActionInfo.nextAction, 'PICK');
    assert.equal(nextPick.PickGameInfo.requestMode, 'legacy-sequential-pick');
});

test('parseResponseText maps legacy XML free-spin trigger state', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: '<Events><WheelBonusEvent freeSpins="10"/><StartFreeSpinsEvent freeSpinsWon="10"/></Events>',
        },
    }, 'Spin');

    assert.equal(data.NextActionInfo.nextAction, 'FREE_SPIN');
});

test('parseResponseText follows Winstones free-spin counts and reads the cumulative win', () => {
    const continuing = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<DisplayWinEvent balance="1995.62" grossWin="0.60" wager="0.00"/>',
                '<UpdateFreeSpinCountEvent freeSpinsRemaining="8" multiplier="3" winTotal="0.60"/>',
                '<GameMetadataEvent/>',
                '</Events>',
            ].join(''),
        },
    }, 'freeSpin');
    const completed = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<DisplayWinEvent balance="2006.00" grossWin="0.00" wager="0.00"/>',
                '<UpdateFreeSpinCountEvent freeSpinsRemaining="0" multiplier="3" winTotal="10.98"/>',
                '<GameOverEvent balance="2006.00"/>',
                '</Events>',
            ].join(''),
        },
    }, 'freeSpin');

    assert.equal(continuing.NextActionInfo.nextAction, 'FREE_SPIN');
    assert.deepEqual(continuing.FreeSpinsInfo, {
        freeSpinsRemaining: 8,
        accumulativeWin: 0.6,
        multiplier: 3,
    });
    assert.equal(continuing.PlayerBalanceInfo.balance, 1995.62);
    assert.equal(completed.NextActionInfo.nextAction, 'SPIN');
    assert.equal(completed.FreeSpinsInfo.freeSpinsRemaining, 0);
    assert.equal(completed.FreeSpinsInfo.accumulativeWin, 10.98);
});

test('parseResponseText maps a cascade with a free-spin state event to FREE_CASCADE', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<ShowFreeSpinEvent freeSpinsRemaining="4"/>',
                '<EnableCascadeEvent/>',
                '</Events>',
            ].join(''),
        },
    }, 'freeSpin');

    assert.equal(data.NextActionInfo.nextAction, 'FREE_CASCADE');
});

test('parseResponseText reads legacy DisplayWinEvent gross win', () => {
    const data = parseResponseText({
        channel: '/service/game',
        data: {
            responseText: [
                '<Events>',
                '<DisplayWinEvent grossWin="3.50" wager="2.50" balance="2001.00"/>',
                '<GameOverEvent balance="2001.00" groupId="legacy-round-1"/>',
                '</Events>',
            ].join(''),
        },
    }, 'Spin');

    assert.equal(data.PlayerBalanceInfo.resultAmount, 3.5);
    assert.equal(data.GameSlotResultInfo.grossWin, 3.5);
    assert.equal(data.PlayerBalanceInfo.balance, 2001);
    assert.equal(data.NextActionInfo.nextAction, 'SPIN');
});

test('小写协议保留 error-only 类型且不重发功能请求', async () => {
    const session = new RoxorCometDSession({gameId:'test', name:'test'}) as any;
    let calls = 0;
    session.callGameRaw = async () => { calls++; return {data:{responseText:'{"error":"provider rejected"}'}}; };
    await assert.rejects(session.callLowercaseFollowUp('FreeSpin', {}), (error: unknown) =>
        error instanceof AGProviderResponseError && error.reason === 'error-only');
    assert.equal(calls, 1);
});
