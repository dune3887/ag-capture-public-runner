import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReplaySequence } from '../src/ag.mongo';
import { parseResponseText } from '../src/ag.client';
import {
    captureAGRound,
    isFreeState,
    isPickState,
    isRoundTerminal,
    selectFreeChoiceOption,
} from '../src/ag.round';

test('旧式 COLLECT 同时带官方结算事件时保留完整局和真实余额', async () => {
    const session = {
        getSpinParams: () => ({}), getPickParams: (pickIndex: number|string) => ({pickIndex}),
        getFallbackBet: () => 2, getBalance: () => 2000,
        callGameData: async (event:string) => parseResponseText({channel:'/service/game',data:{responseText:event==='Spin'
            ? '<Events><UpdateBalancePostWagerEvent balance="1998"/><PickBonusEvent id="1" initiatingLines="7"/></Events>'
            : '<Events><PickItemEvent isLast="true"><PickItem type="COLLECT" value="0"/></PickItemEvent><PickBonusResultEvent balance="2033.40" grossWin="35.40"/><GameOverEvent balance="2033.40"/></Events>'}}, event),
    };
    const round=await captureAGRound(session);
    assert.equal(round.data.requiresSessionReset,false);
    assert.equal(round.data.roundTerminalAction,'SPIN');
    assert.equal(round.balance,2033.4);
    assert.ok(Math.abs(round.win-35.4)<1e-7);
    assert.doesNotThrow(()=>validateReplaySequence(round.data));
});

test('selectFreeChoiceOption chooses the least covered option with stable tie break', () => {
    const picked = selectFreeChoiceOption(
        [{ pickIndex: 3 }, { pickIndex: 1 }, { pickIndex: 2 }],
        { 1: 2, 2: 0, 3: 0 },
    );

    assert.equal(picked?.pickIndex, 2);
});

test('旧式分轮选择保存实际协议索引，不把轮次当位置', async () => {
    const seen:number[]=[];
    const session={getSpinParams:()=>({}),getPickParams:(pickIndex:number|string)=>({pickIndex}),getFallbackBet:()=>1,
        getSequentialPickIndex:(index:number)=>index*3,
        callGameData:async(event:string,params:Record<string,any>|null)=>{
            if(event!=='Spin')seen.push(Number(params?.pickIndex));
            return {NextActionInfo:{nextAction:seen.length===3?'SPIN':'PICK'},
                PickGameInfo:{requestMode:'legacy-sequential-pick',requestEvent:'Pick'},PlayerBalanceInfo:{wager:1,balance:100,resultAmount:0}};
        }};
    const round=await captureAGRound(session);
    assert.deepEqual(seen,[0,3,6]);
    assert.deepEqual(round.data.freeChoiceSteps.map((step:any)=>step.parameters.pickIndex),['0','3','6']);
});

test('each Cashman hand choice reuses 0/1 rather than advancing a sequential pick cursor', async () => {
    const selected: number[]=[];
    const session={
        getSpinParams:()=>({}),getPickParams:(pickIndex:number|string)=>({pickIndex}),getFallbackBet:()=>1,
        callGameData:async(event:string,params:Record<string,any>|null)=>{
            if(event!=='Spin') selected.push(Number(params?.pickIndex));
            return {NextActionInfo:{nextAction:selected.length===3?'SPIN':'CASHMAN_PICK'},PlayerBalanceInfo:{wager:1,balance:100,resultAmount:0}};
        },
    };
    const round=await captureAGRound(session,{chooseOption:options=>options[1]});
    assert.deepEqual(selected,[1,0,0]);
    assert.equal(round.optionCount,2);
    assert.equal(round.optionIndex,2);
    for(const step of round.data.freeChoiceSteps) assert.deepEqual(step.selectableIndexes,[0,1]);
});

test('pickInfos exposes all Royal Monkey choices as official 1-based request IDs', async () => {
    const session = {
        getSpinParams: () => ({}), getPickParams: (pickIndex: number | string) => ({pickIndex}), getFallbackBet: () => 1,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            if (event === 'Spin') return { NextActionInfo: {nextAction:'PICK',id:'FREE_GAME_PICK'},
                PickGameInfo: {pickInfos:[{pickType:'FREE_SPIN_2G'},{pickType:'FREE_SPIN_3G'},{pickType:'MYSTERY'}]},
                PlayerBalanceInfo: {wager:1,balance:99,resultAmount:0} };
            assert.equal(Number(params?.pickIndex),3);
            return {NextActionInfo:{nextAction:'SPIN'},PlayerBalanceInfo:{balance:100,resultAmount:1}};
        },
    };
    const result=await captureAGRound(session,{chooseOption:options=>options[2]});
    assert.equal(result.optionCount,3);
    assert.equal(result.optionIndex,3);
    assert.deepEqual(result.data.freeChoiceSteps[0].selectableIndexes,[1,2,3]);
});

test('XML actual debit overrides inferred line-count wager without altering raw trigger', async () => {
    const session = {
        getSpinParams: () => ({ coinSize: '0.1', numberOfCoins: '1,1,1,1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex }),
        getFallbackBet: () => 5,
        getBalance: () => 2000,
        callGameData: async () => ({
            NextActionInfo: { nextAction: 'SPIN' },
            PlayerBalanceInfo: { wager: 0, balance: 1999.9, resultAmount: 0.9 },
            XmlEvents: { SetBalanceEvent: { balance: '1999.00' }, GameOverEvent: { balance: '1999.90' } },
        }),
    };
    const result = await captureAGRound(session);
    assert.equal(result.bet, 1);
    assert.ok(Math.abs(result.win - 0.9) < 1e-7);
    assert.equal(result.data.roundBetSource, 'balance-delta');
    assert.equal(result.data.roundTrigger.PlayerBalanceInfo.wager, 0);
    assert.doesNotThrow(() => validateReplaySequence(result.data));
});

test('capture records successful wire events and supports both automatic wheels', async () => {
    let last: { event: string; parameters: Record<string, any> | null } | undefined;
    const seen: string[] = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex }),
        getFallbackBet: () => 0.01,
        getLastGameRequest: () => last,
        callGameData: async (event: string, parameters: Record<string, any> | null) => {
            seen.push(event);
            last = { event: event === 'Spin' ? 'spin' : event, parameters };
            const actions: Record<string, string> = { Spin: 'GREEN_WHEEL_SPIN', greenwheelspin: 'GOLDEN_WHEEL_SPIN', goldenwheelspin: 'SPIN' };
            assert.ok(actions[event]);
            return { NextActionInfo: { nextAction: actions[event] }, PlayerBalanceInfo: { wager: 0.01, balance: 100, resultAmount: 0 } };
        },
    };
    const result = await captureAGRound(session);
    assert.deepEqual(seen, ['Spin', 'greenwheelspin', 'goldenwheelspin']);
    assert.equal(result.data.roundRequest.event, 'spin');
    assert.deepEqual(result.data.roundEvents, ['spin', 'greenwheelspin', 'goldenwheelspin']);
    assert.equal(result.data.freeChoiceSteps.every((step: any) => !step.requiresPickIndex), true);
});

test('automatic player reveal keeps capture probe index optional for replay', async () => {
    const session = {
        getSpinParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex }),
        getFallbackBet: () => 1,
        callGameData: async (event: string, parameters: Record<string, any> | null) => {
            if (event === 'Spin') {
                return { NextActionInfo: { nextAction: 'PICK' }, PlayerBalanceInfo: { wager: 1, balance: 99, resultAmount: 0 } };
            }
            if (event === 'pick') {
                assert.equal(String(parameters?.pickIndex), '0');
                return {
                    NextActionInfo: { nextAction: 'FREE_SPIN' },
                    PlayerBalanceInfo: { balance: 99, resultAmount: 0 },
                    PlayerRevealEvent: { remainingPicks: 0 },
                };
            }
            return { NextActionInfo: { nextAction: 'SPIN' }, PlayerBalanceInfo: { balance: 101, resultAmount: 2 } };
        },
    };

    const result = await captureAGRound(session);
    assert.equal(result.data.freeChoiceSteps[0].parameters.pickIndex, 0);
    assert.equal(result.data.freeChoiceSteps[0].requiresPickIndex, false);
    assert.doesNotThrow(() => validateReplaySequence(result.data));
});

test('round state helpers identify pick, free, and terminal next actions', () => {
    assert.equal(isPickState('PICK'), true);
    assert.equal(isPickState('pick_screen'), true);
    assert.equal(isPickState('PICK_FREE_SPINS'), true);
    assert.equal(isPickState('PICK_GOLD_COIN'), true);
    assert.equal(isFreeState('FREE_SPIN'), true);
    assert.equal(isFreeState('FREE_CASCADE'), true);
    assert.equal(isRoundTerminal('SPIN'), true);
    assert.equal(isRoundTerminal('BASE'), true);
    assert.equal(isRoundTerminal('FREE_SPIN'), false);
});

test('captureAGRound maps special AG free-spin actions to the game-specific event name', async () => {
    const events: string[] = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        callGameData: async (event: string) => {
            events.push(event);
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                    NextActionInfo: { nextAction: 'MORE_CHILLI_FREE_SPIN' },
                };
            }
            if (event === 'moreChilliFreeSpin') {
                return {
                    PlayerBalanceInfo: { resultAmount: 1, balance: 100 },
                    FreeSpinsInfo: { accumulativeWin: 1 },
                    NextActionInfo: { nextAction: 'SPIN' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(events, ['Spin', 'moreChilliFreeSpin']);
    assert.equal(round.isFeature, true);
    assert.equal(round.win, 1);
    assert.equal(round.data.roundTrigger.NextActionInfo.nextAction, 'MORE_CHILLI_FREE_SPIN');
    assert.equal(round.data.NextActionInfo.nextAction, 'SPIN');
    assert.equal(round.data.roundSchemaVersion, 3);
    assert.equal(round.data.roundWin, 1);
    assert.equal(round.data.freeChoiceSteps[0].action, 'MORE_CHILLI_FREE_SPIN');
    assert.equal(round.data.freeChoiceSteps[0].requiresPickIndex, false);
    assert.doesNotThrow(() => validateReplaySequence(round.data));
});

test('captureAGRound maps special AG pick actions to the game-specific pick event name', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                    PickGameInfo: { pickOptions: [{ pickIndex: 2 }, { pickIndex: 1 }] },
                    NextActionInfo: { nextAction: 'MORE_CHILLI_CASHMAN_PICK' },
                };
            }
            if (event === 'moreChilliCashmanPick') {
                return {
                    PlayerBalanceInfo: { resultAmount: 1, balance: 100 },
                    NextActionInfo: { nextAction: 'SPIN' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session, { chooseOption: (options) => options[1] });

    assert.equal(calls[1].event, 'moreChilliCashmanPick');
    assert.deepEqual(calls[1].params, { pickIndex: '1' });
    assert.equal(round.optionIndex, 1);
    assert.equal(round.optionCount, 2);
});

test('captureAGRound supplies sequential 0-based pick indexes when AG pick state has no option list', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            if (event === 'pick') {
                if (calls.length === 2) {
                    return {
                        PlayerBalanceInfo: { resultAmount: 0, balance: 99 },
                        NextActionInfo: { nextAction: 'PICK' },
                    };
                }
                return {
                    PlayerBalanceInfo: { resultAmount: 1, balance: 100 },
                    NextActionInfo: { nextAction: 'SPIN' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session);

    assert.equal(calls[1].event, 'pick');
    assert.deepEqual(calls.slice(1).map((call) => call.params), [
        { pickIndex: '0' },
        { pickIndex: '1' },
    ]);
    assert.equal(round.optionIndex, 1);
    assert.equal(round.optionCount, 1);
});

test('captureAGRound maps raw picks to official 1-based option IDs', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                    PickGameInfo: {
                        picks: [
                            { pickType: 'FREE_SPIN_GAME', freeSpins: 8 },
                            { pickType: 'LUXURY_LINE', freeSpins: 1 },
                        ],
                    },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            if (event === 'pick') {
                return {
                    PlayerBalanceInfo: { resultAmount: 1, balance: 100 },
                    NextActionInfo: { nextAction: 'SPIN' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session, { chooseOption: (options) => options[1] });

    assert.deepEqual(calls[1], { event: 'pick', params: { pickIndex: '2' } });
    assert.equal(round.optionIndex, 2);
    assert.equal(round.optionCount, 2);
});

test('captureAGRound uses Gold Stacks 1-based choice IDs then clears the one-time option list', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                    PickGameInfo: {
                        picks: [
                            { pickType: 'FREE_SPIN_12G', freeSpins: 25 },
                            { pickType: 'FREE_SPIN_24G', freeSpins: 15 },
                        ],
                    },
                    NextActionInfo: { nextAction: 'PICK', id: 'FREE_GAME_PICK' },
                };
            }
            if (calls.length === 2) {
                return {
                    JackpotPickResultInfo: { jackpot: 'MINI' },
                    NextActionInfo: { nextAction: 'PICK', id: 'FREE_GAME_PICK' },
                };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 1, balance: 100 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session, { chooseOption: (options) => options[1] });

    assert.deepEqual(calls.slice(1).map((call) => call.params), [
        { pickIndex: '2' },
        { pickIndex: '0' },
    ]);
    assert.equal(round.optionIndex, 2);
    assert.equal(round.optionCount, 2);
});

test('captureAGRound maps BONUS_SPIN to the official bonusSpin event', async () => {
    const events: string[] = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getFollowUpParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        callGameData: async (event: string) => {
            events.push(event);
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                    NextActionInfo: { nextAction: 'BONUS_SPIN' },
                };
            }
            if (event === 'bonusSpin') {
                return {
                    PlayerBalanceInfo: { resultAmount: 2, balance: 101 },
                    NextActionInfo: { nextAction: 'SPIN' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(events, ['Spin', 'bonusSpin']);
    assert.equal(round.isFeature, true);
    assert.equal(round.win, 2);
});

test('captureAGRound maps newly observed feature actions to their official events', async () => {
    const mappings = [
        ['RIBBON_WHEEL_SPIN', 'ribbonWheelSpin'],
        ['WHEEL_SPIN', 'wheelSpin'],
        ['CLOWN_BALL_DROP', 'clownBallDrop'],
        ['BONUS', 'BonusSpin'],
        ['FREE_FEATURE', 'freefeature'],
        ['FREE_PICK', 'freepick'],
    ] as const;

    for (const [action, expectedEvent] of mappings) {
        const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
        const session = {
            getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
            getActionParams: (_action: string, event: string) => event === 'BonusSpin' ? {} : { coinSize: '0.01' },
            getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
            getFallbackBet: () => 0.02,
            callGameData: async (event: string, params: Record<string, any> | null) => {
                calls.push({ event, params });
                if (event === 'Spin') {
                    return {
                        PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                        NextActionInfo: { nextAction: action },
                    };
                }
                if (event === expectedEvent) {
                    return {
                        PlayerBalanceInfo: { resultAmount: 1, balance: 100 },
                        NextActionInfo: { nextAction: 'SPIN' },
                    };
                }
                throw new Error(`unexpected event ${event}`);
            },
        };

        const round = await captureAGRound(session);

        assert.equal(calls[1].event, expectedEvent, action);
        const expectedParams = expectedEvent === 'BonusSpin'
            ? {}
            : expectedEvent === 'freepick'
                ? { pickIndex: '0' }
                : { coinSize: '0.01' };
        assert.deepEqual(calls[1].params, expectedParams, action);
        assert.equal(round.isFeature, true, action);
        assert.equal(round.win, 1, action);
    }
});

test('captureAGRound retries a follow-up state with the next event candidate before failing the round', async () => {
    const events: string[] = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getFollowUpParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        callGameData: async (event: string) => {
            events.push(event);
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.02, resultAmount: 0, balance: 99 },
                    NextActionInfo: { nextAction: 'FREE_SPIN' },
                };
            }
            if (event === 'freeSpin' || event === 'freespin' || event === 'FreeSpin') {
                throw new Error('FreeSpin: {"type":"MalformedRequest"}');
            }
            if (event === 'FreeSpins') {
                return {
                    PlayerBalanceInfo: { resultAmount: 1, balance: 100 },
                    FreeSpinsInfo: { accumulativeWin: 1 },
                    NextActionInfo: { nextAction: 'SPIN' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(events, ['Spin', 'freeSpin', 'freespin', 'FreeSpin', 'FreeSpins']);
    assert.equal(round.win, 1);
});

test('captureAGRound negotiates FREE_SPIN as respin and reuses it for the rest of the feature', async () => {
    const events: string[] = [];
    let respins = 0;
    const session = {
        getSpinParams: () => ({ coinSize: '0.05', numberOfCoins: '1,1,1,1,1,1' }),
        getFollowUpParams: () => ({ coinSize: '0.05', numberOfCoins: '1,1,1,1,1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.3,
        callGameData: async (event: string) => {
            events.push(event);
            if (event === 'Spin' && events.length === 1) {
                return {
                    PlayerBalanceInfo: { wager: 0.3, resultAmount: 0, balance: 99.7 },
                    NextActionInfo: { nextAction: 'FREE_SPIN' },
                };
            }
            if (event === 'respin') {
                respins += 1;
                return respins === 1
                    ? {
                        PlayerBalanceInfo: { resultAmount: 0.5, balance: 100.2 },
                        FreeSpinsInfo: { accumulativeWin: 0.5 },
                        NextActionInfo: { nextAction: 'FREE_SPIN' },
                    }
                    : {
                        PlayerBalanceInfo: { resultAmount: 0.5, balance: 100.7 },
                        FreeSpinsInfo: { accumulativeWin: 1 },
                        NextActionInfo: { nextAction: 'SPIN' },
                    };
            }
            throw new Error(`${event}: {"type":"MalformedRequest"}`);
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(events, [
        'Spin',
        'freeSpin',
        'freespin',
        'FreeSpin',
        'FreeSpins',
        'Spin',
        'respin',
        'respin',
    ]);
    assert.equal(round.win, 1);
});

test('captureAGRound follows legacy XML Pick with sequential index-only requests', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ autoPlay: 'false', coinSize: '0.10', numberOfCoins: '1,1' }),
        getPickEvent: () => 'PickRequest',
        getPickParams: (pickIndex: number | string) => ({ roundIndex: 0, pickIndex: String(pickIndex), autoPick: false }),
        getFallbackBet: () => 0.2,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.2 },
                    PickGameInfo: { requestMode: 'legacy-sequential-pick', requestEvent: 'Pick' },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            if (calls.length === 2) {
                return {
                    PickGameInfo: { requestMode: 'legacy-sequential-pick', requestEvent: 'Pick' },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 6.35, balance: 106.15 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(calls, [
        { event: 'Spin', params: { autoPlay: 'false', coinSize: '0.10', numberOfCoins: '1,1' } },
        { event: 'Pick', params: { pickIndex: '0' } },
        { event: 'Pick', params: { pickIndex: '1' } },
    ]);
    assert.equal(round.isFeature, true);
    assert.equal(round.optionIndex, 0);
    assert.equal(round.win, 6.35);
    assert.equal(round.data.freeChoiceSteps.length, 2);
});

test('captureAGRound preserves Fortune Temple 1-based multi-round mode across RoundPickEvent', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ autoPlay: 'false', coinSize: '0.10', numberOfCoins: '1,1' }),
        getFollowUpParams: () => ({ coinSize: '0.10', numberOfCoins: '1,1' }),
        getActionParams: (_action: string, event: string) => event === 'RoundPickEvent' ? null : {},
        getPickParams: (pickIndex: number | string) => ({ roundIndex: 0, pickIndex: String(pickIndex), autoPick: false }),
        getFallbackBet: () => 0.2,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.2 },
                    PickGameInfo: { requestMode: 'legacy-multiround-pick', requestEvent: 'Pick' },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            if (calls.length === 2) {
                return { NextActionInfo: { nextAction: 'NEXT_PICK_ROUND' } };
            }
            if (event === 'RoundPickEvent') {
                return {
                    PickGameInfo: { requestMode: 'legacy-sequential-pick', requestEvent: 'Pick' },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 3, balance: 102.8 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(calls, [
        { event: 'Spin', params: { autoPlay: 'false', coinSize: '0.10', numberOfCoins: '1,1' } },
        { event: 'Pick', params: { pickIndex: '1' } },
        { event: 'RoundPickEvent', params: null },
        { event: 'Pick', params: { pickIndex: '2' } },
    ]);
    assert.equal(round.win, 3);
});

test('captureAGRound ends Fortune Temple preloaded pick mode on the local COLLECT result', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ autoPlay: 'false', coinSize: '0.10', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.2,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 0.2, resultAmount: 4, balance: 103.8 },
                    PickGameInfo: { requestMode: 'legacy-preloaded-pick', requestEvent: 'Pick' },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 0, balance: 103.8 },
                NextActionInfo: { nextAction: 'PICK' },
                XmlEvents: {
                    PickItemEvent: {
                        isLast: 'true',
                        PickItem: { type: 'COLLECT', value: '0' },
                    },
                },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(calls, [
        { event: 'Spin', params: { autoPlay: 'false', coinSize: '0.10', numberOfCoins: '1,1' } },
        { event: 'Pick', params: { pickIndex: '0' } },
    ]);
    assert.equal(round.win, 4);
    assert.equal(round.data.requiresSessionReset, true);
});

test('captureAGRound calculates stateful Fortune Temple picked coins with line multiplier', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const results = [
        { type: 'WIN', value: '40', isLast: 'false' },
        { type: 'WIN', value: '5', isLast: 'false' },
        { type: 'COLLECT', value: '0', isLast: 'true' },
    ];
    const session = {
        getSpinParams: () => ({ autoPlay: 'false', coinSize: '0.10', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 2.5,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 2.5, resultAmount: 0, balance: 100 },
                    GameWageringInfo: { currentCoinSize: 0.1 },
                    PickGameInfo: {
                        requestMode: 'legacy-stateful-spin-pick',
                        requestEvent: 'Pick',
                        bonusMultiplier: 2,
                    },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            const result = results[calls.length - 2];
            return {
                PlayerBalanceInfo: { resultAmount: 0, balance: 0 },
                NextActionInfo: { nextAction: 'PICK' },
                XmlEvents: {
                    PickItemEvent: {
                        isLast: result.isLast,
                        PickItem: { type: result.type, value: result.value },
                    },
                },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(calls.slice(1).map((call) => call.params), [
        { pickIndex: '0' },
        { pickIndex: '1' },
        { pickIndex: '2' },
    ]);
    assert.equal(round.win, 9);
    assert.equal(round.balance, 109);
    assert.equal(round.data.requiresSessionReset, true);
});

test('captureAGRound maps Heart of the Sea feature actions to official protocol events', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const followParams = { coinSize: '0.05', numberOfCoins: '1,1' };
    const session = {
        getSpinParams: () => followParams,
        getFollowUpParams: () => followParams,
        getPickParams: (pickIndex: number | string) => ({ ...followParams, pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.1,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            const nextByEvent: Record<string, string> = {
                Spin: 'PICK_FREE_SPINS',
                pickFreeSpins: 'FREE_SPIN',
                freeSpin: 'PICK_GOLD_COIN',
                pickGoldCoins: 'MIGHTY_CASH_SPIN',
                mightyCashSpin: 'SPIN',
            };
            return {
                PlayerBalanceInfo: {
                    wager: event === 'Spin' ? 0.1 : undefined,
                    resultAmount: event === 'mightyCashSpin' ? 8 : 0,
                    balance: 108,
                },
                NextActionInfo: { nextAction: nextByEvent[event] },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(calls, [
        { event: 'Spin', params: followParams },
        { event: 'pickFreeSpins', params: { ...followParams, pickIndex: '0' } },
        { event: 'freeSpin', params: followParams },
        { event: 'pickGoldCoins', params: followParams },
        { event: 'mightyCashSpin', params: followParams },
    ]);
    assert.equal(round.isFeature, true);
    assert.equal(round.win, 8);
});

test('captureAGRound stores the cumulative XML free-spin win instead of only the final spin win', async () => {
    let call = 0;
    const session = {
        getSpinParams: () => ({ coinSize: '0.02', numberOfCoins: Array(25).fill('1').join(',') }),
        getActionParams: () => ({ autoPlay: 'false' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.5,
        callGameData: async () => {
            call += 1;
            if (call === 1) {
                return {
                    PlayerBalanceInfo: { wager: 0.5, balance: 1999.5 },
                    NextActionInfo: { nextAction: 'FREE_SPIN' },
                };
            }
            if (call === 2) {
                return {
                    FreeSpinsInfo: { freeSpinsRemaining: 1, accumulativeWin: 2.5 },
                    PlayerBalanceInfo: { resultAmount: 2.5, balance: 2002 },
                    NextActionInfo: { nextAction: 'FREE_SPIN' },
                };
            }
            return {
                FreeSpinsInfo: { freeSpinsRemaining: 0, accumulativeWin: 3.75 },
                PlayerBalanceInfo: { resultAmount: 1.25, balance: 2003.25 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.equal(round.isFeature, true);
    assert.equal(round.win, 3.75);
    assert.equal(round.data.PlayerBalanceInfo.resultAmount, 3.75);
});

test('captureAGRound follows wager-first games and does not classify setup steps as a feature', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.01', numberOfCoins: '1,1' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.02,
        getInitialRoundRequest: () => ({
            event: 'wager',
            parameters: { coinSize: '0.01', numberOfCoins: '1,1' },
        }),
        getActionParams: () => ({}),
        isRoundTerminalAction: (action: string) => action === 'WAGER',
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'wager') {
                return { PlayerBalanceInfo: { wager: 0.02 }, NextActionInfo: { nextAction: 'SPIN' } };
            }
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { resultAmount: 0.1, balance: 100.08 },
                    NextActionInfo: { nextAction: 'WAGER' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(calls.map((call) => call.event), ['wager', 'Spin']);
    assert.deepEqual(calls[1].params, {});
    assert.equal(round.isFeature, false);
    assert.equal(round.win, 0.1);
    assert.deepEqual(round.data.roundEvents, ['wager', 'Spin']);
    assert.equal(round.data.freeChoiceSteps.length, 1);
    assert.equal(round.data.roundTerminalAction, 'WAGER');
    assert.doesNotThrow(() => validateReplaySequence(round.data));
});

test('captureAGRound follows scratchcard play and jackpotplay actions', async () => {
    const events: string[] = [];
    const session = {
        getSpinParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 2,
        getInitialRoundRequest: () => ({ event: 'play', parameters: { wager: '2.00' } }),
        getActionParams: () => ({}),
        isRoundTerminalAction: (action: string) => action === 'PLAY',
        callGameData: async (event: string) => {
            events.push(event);
            if (event === 'play') {
                return { PlayerBalanceInfo: { wager: 2 }, NextActionInfo: { nextAction: 'JACKPOT_PLAY' } };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 5, balance: 1003 },
                NextActionInfo: { nextAction: 'PLAY' },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(events, ['play', 'jackpotplay']);
    assert.equal(round.isFeature, false);
    assert.equal(round.win, 5);
});

test('captureAGRound rejects unknown nextAction instead of mapping it to Spin', async () => {
    const session = {
        getSpinParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 1,
        callGameData: async () => ({
            PlayerBalanceInfo: { wager: 1 },
            NextActionInfo: { nextAction: 'UNSUPPORTED_ACTION' },
        }),
    };

    await assert.rejects(() => captureAGRound(session), /unsupported AG nextAction: UNSUPPORTED_ACTION/);
});

test('captureAGRound follows XML cascades and sums every cascade win', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.10', numberOfCoins: Array(25).fill('1').join(',') }),
        getActionParams: (_action: string, event: string) => event === 'Cascade' ? {} : null,
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 2.5,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    XmlEvents: { ShowWinEvent: { grossWin: '0.90' }, EnableCascadeEvent: '' },
                    PlayerBalanceInfo: { wager: 2.5, resultAmount: 0.9, balance: 1998.4 },
                    NextActionInfo: { nextAction: 'CASCADE' },
                };
            }
            if (event === 'Cascade') {
                return {
                    XmlEvents: { ShowWinEvent: { grossWin: '0.40' }, EnableGameEvent: '' },
                    PlayerBalanceInfo: { resultAmount: 0.4, balance: 1998.8 },
                    NextActionInfo: { nextAction: 'SPIN' },
                };
            }
            throw new Error(`unexpected event ${event}`);
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(calls.map((call) => call.event), ['Spin', 'Cascade']);
    assert.deepEqual(calls[1].params, {});
    assert.equal(round.isFeature, true);
    assert.equal(round.data.freeChoiceSteps.length, 1);
    assert.doesNotThrow(() => validateReplaySequence(round.data));
    assert.equal(round.win, 1.3);
    assert.equal(round.data.PlayerBalanceInfo.resultAmount, 1.3);
    assert.deepEqual(round.data.roundEvents, ['Spin', 'Cascade']);
});

test('captureAGRound uses the balance delta for JSON cascades whose terminal step reports zero', async () => {
    let call = 0;
    const session = {
        getSpinParams: () => ({ coinSize: '0.20', numberOfCoins: Array(10).fill('1').join(',') }),
        getActionParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 2,
        callGameData: async () => {
            call += 1;
            if (call === 1) {
                return {
                    PlayerBalanceInfo: {
                        preWagerBalance: 1878.8,
                        wager: 2,
                        resultAmount: 0.4,
                        balance: 1877.2,
                    },
                    NextActionInfo: { nextAction: 'CASCADE' },
                };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 0, balance: 1877.2 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.equal(round.win, 0.4);
    assert.equal(round.data.winResolution.method, 'balance-delta');
    assert.equal(round.data.winResolution.balanceDerivedWin, 0.4);
});

test('captureAGRound restores a scratchcard reward when jackpotplay reports zero', async () => {
    const events: string[] = [];
    const session = {
        getSpinParams: () => ({}),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 2,
        getInitialRoundRequest: () => ({ event: 'play', parameters: { wager: '2.00' } }),
        getActionParams: () => ({}),
        isRoundTerminalAction: (action: string) => action === 'PLAY',
        callGameData: async (event: string) => {
            events.push(event);
            if (event === 'play') {
                return {
                    PlayerBalanceInfo: { preWagerBalance: 2186, wager: 2, resultAmount: 30, balance: 2214 },
                    NextActionInfo: { nextAction: 'JACKPOT_PLAY' },
                };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 0, balance: 2214 },
                NextActionInfo: { nextAction: 'PLAY' },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.deepEqual(events, ['play', 'jackpotplay']);
    assert.equal(round.win, 30);
    assert.equal(round.data.winResolution.protocolWin, 30);
    assert.equal(round.data.winResolution.balanceDerivedWin, 30);
});

test('captureAGRound keeps the latest explicit XML balance when the terminal cascade omits it', async () => {
    let call = 0;
    const session = {
        getSpinParams: () => ({ coinSize: '0.10', numberOfCoins: '1' }),
        getActionParams: () => ({ autoPlay: 'false' }),
        getPickParams: (pickIndex: number | string) => ({ pickIndex: String(pickIndex) }),
        getFallbackBet: () => 0.1,
        callGameData: async () => {
            call += 1;
            if (call === 1) {
                return {
                    XmlEvents: { CountUpBalanceEvent: { from: '99.90', to: '100.40' }, EnableCascadeEvent: '' },
                    PlayerBalanceInfo: { wager: 0.1, resultAmount: 0.5, balance: 100.4 },
                    NextActionInfo: { nextAction: 'CASCADE' },
                };
            }
            return {
                XmlEvents: { GameFinishedEvent: '', EnableGameEvent: '' },
                PlayerBalanceInfo: { resultAmount: 0, balance: 0 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session);

    assert.equal(round.balance, 100.4);
    assert.equal(round.data.PlayerBalanceInfo.balance, 100.4);
    assert.equal(round.win, 0.5);
});

test('captureAGRound sends the original 0-based XML pick index to PickRequest', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.10', numberOfCoins: '1' }),
        getPickEvent: () => 'PickRequest',
        getPickParams: (pickIndex: number | string) => ({ roundIndex: 0, pickIndex: String(pickIndex), autoPick: false }),
        getFallbackBet: () => 1,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 1 },
                    PickGameInfo: {
                        optionCount: 2,
                        pickOptions: [
                            { pickIndex: 1, requestPickIndex: '0' },
                            { pickIndex: 2, requestPickIndex: '1' },
                        ],
                    },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 2, balance: 101 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session, { chooseOption: (options) => options[0] });

    assert.deepEqual(calls[1], {
        event: 'PickRequest',
        params: { roundIndex: 0, pickIndex: '0', autoPick: false },
    });
    assert.equal(round.optionIndex, 1);
    assert.equal(round.optionCount, 2);
});

test('captureAGRound remembers remaining XML pick options when later responses omit the list', async () => {
    const calls: Array<{ event: string; params: Record<string, any> | null }> = [];
    const session = {
        getSpinParams: () => ({ coinSize: '0.10', numberOfCoins: '1' }),
        getPickEvent: () => 'PickRequest',
        getPickParams: (pickIndex: number | string) => ({ roundIndex: 0, pickIndex: String(pickIndex), autoPick: false }),
        getFallbackBet: () => 1,
        callGameData: async (event: string, params: Record<string, any> | null) => {
            calls.push({ event, params });
            if (event === 'Spin') {
                return {
                    PlayerBalanceInfo: { wager: 1 },
                    PickGameInfo: {
                        optionCount: 3,
                        pickOptions: [
                            { pickIndex: 1, requestPickIndex: '0' },
                            { pickIndex: 2, requestPickIndex: '1' },
                            { pickIndex: 3, requestPickIndex: '2' },
                        ],
                    },
                    NextActionInfo: { nextAction: 'PICK' },
                };
            }
            if (calls.length === 2) {
                return { NextActionInfo: { nextAction: 'PICK' } };
            }
            return {
                PlayerBalanceInfo: { resultAmount: 2, balance: 101 },
                NextActionInfo: { nextAction: 'SPIN' },
            };
        },
    };

    const round = await captureAGRound(session, { chooseOption: (options) => options[0] });

    assert.deepEqual(calls.slice(1).map((call) => call.params?.pickIndex), ['0', '1']);
    assert.equal(round.optionIndex, 1);
    assert.equal(round.optionCount, 3);
});
