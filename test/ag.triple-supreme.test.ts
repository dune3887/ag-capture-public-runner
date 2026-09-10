import test from 'node:test';
import assert from 'node:assert/strict';
import { RoxorCometDSession } from '../src/ag.client';
import { captureAGRound, AGInitialSpinRuntimeError } from '../src/ag.round';
import { isDeterministicCaptureError } from '../src/ag.scheduler';
import { validateReplaySequence } from '../src/ag.mongo';

const artifacts = ['rgp-game-triple-supreme-xtreme-heart-of-the-sea', 'rgp-game-triple-supreme-xtreme-grand-prosperity'];
function makeSession(artifact = artifacts[0]) {
    return new RoxorCometDSession({ gameId: 'test', name: 'test', backendArtifactId: artifact });
}
for (const artifact of artifacts) {
    for (const choice of [1, 2, 3, 4]) {
        test(artifact + ' 免费选择 ' + choice + ' 独立于 Match3 揭示且记录完整局', async () => {
            const session = makeSession(artifact);
            const calls: Array<{event: string; parameters: Record<string, any> | null}> = [];
            const response = (action: string, extra = {}) => ({
                PlayerBalanceInfo: { resultAmount: action === 'SPIN' ? 2 : 0, balance: action === 'SPIN' ? 101.6 : 99.6 },
                NextActionInfo: { nextAction: action }, ...extra,
            });
            const trigger = response('PICK', {PlayerBalanceInfo: {wager: 0.4, preWagerBalance: 100, balance: 99.6}, Match3Result: {revealedSymbols: [{pickIndex: 0}, {pickIndex: 2}]}});
            session.callGameData = async (event, parameters) => {
                calls.push(structuredClone({event, parameters}));
                switch(calls.length) {
                    case 1: assert.equal(event, 'Spin'); return trigger;
                    case 2: assert.equal(event, 'Pick'); assert.deepEqual(parameters, {pickIndex: '1'}); return response('PICK', {Match3Result: {revealedSymbols: [{pickIndex: 0}, {pickIndex: 1}, {pickIndex: 2}]}});
                    case 3: assert.equal(event, 'Pick'); assert.deepEqual(parameters, {pickIndex: '3'}); return response('PICK_FREE_SPINS');
                    case 4: assert.equal(event, 'pickfreespins'); assert.deepEqual(parameters, {pickIndex: String(choice - 1)}); return response('FREE_SPIN');
                    case 5: assert.equal(event, 'freeSpin'); return response('PICK', {Match3Result: {revealedSymbols: []}});
                    case 6: assert.equal(event, 'Pick'); assert.deepEqual(parameters, {pickIndex: '0'}); return response('SPIN');
                    default: throw new Error('unexpected extra request');
                }
            };
            session.getLastGameRequest = () => calls[calls.length - 1];
            let choices = 0;
            const round = await captureAGRound(session, {chooseOption: options => { choices++; return options.find(o => o.pickIndex === choice)!; }});
            assert.equal(choices, 1);
            assert.equal(round.optionIndex, choice);
            assert.equal(round.optionCount, 4);
            assert.equal(round.bet, 0.4);
            assert.equal(round.win, 2);
            assert.equal(round.isFeature, true);
            assert.deepEqual(round.data.roundTrigger, trigger);
            assert.deepEqual(round.data.roundRequest, calls[0]);
            assert.deepEqual(round.data.roundEvents, calls.map(c=>c.event));
            assert.deepEqual(round.data.freeChoiceSteps.map((s: any) => ({event:s.event,parameters:s.parameters})), calls.slice(1));
            assert.doesNotThrow(()=>validateReplaySequence(round.data));
        });
    }
}
for (const action of ['PICK', 'PICK_FREE_SPINS']) {
    for (const type of ['MalformedRequest', 'RuntimeError']) {
        test(action + ' ' + type + ' 不换事件/索引、不新开 Spin', async () => {
            const session = makeSession(); const calls: string[] = [];
            session.callGameData = async (event, parameters) => {
                calls.push(event);
                if(calls.length === 1) return {NextActionInfo:{nextAction:action},Match3Result:{revealedSymbols:[]}};
                assert.equal(event, action === 'PICK' ? 'Pick' : 'pickfreespins');
                assert.deepEqual(parameters,{pickIndex:'0'});
                throw new Error(JSON.stringify({type}));
            };
            await assert.rejects(captureAGRound(session), (e: unknown) => e instanceof Error && e.message.includes(type) && !(e instanceof AGInitialSpinRuntimeError) && isDeterministicCaptureError(e));
            assert.equal(calls.length,2);
        });
    }
}

test('Match3 单独揭示不冒充免费四选一，最后未揭示位置仍可选', async () => {
    const session=makeSession(); let calls=0;
    session.callGameData=async(event,parameters)=>{calls++;
        if(calls===1)return {NextActionInfo:{nextAction:'PICK'},Match3Result:{revealedSymbols:Array.from({length:11},(_,pickIndex)=>({pickIndex}))}};
        assert.equal(event,'Pick');assert.deepEqual(parameters,{pickIndex:'11'});
        return {NextActionInfo:{nextAction:'SPIN'},PlayerBalanceInfo:{resultAmount:1}};
    };
    const round=await captureAGRound(session,{chooseOption:()=>{throw Error('reveals are not free choices');}});
    assert.equal(round.optionIndex,0);assert.equal(round.optionCount,0);assert.equal(round.isFeature,true);
});
for(const revealed of [null,[{pickIndex:-1}],[{pickIndex:12}],[{pickIndex:''}],[{pickIndex:0},{pickIndex:0}],Array.from({length:12},(_,pickIndex)=>({pickIndex}))]) {
    test('异常或耗尽的 Match3 索引拒绝继续请求: '+JSON.stringify(revealed),async()=>{
        const session=makeSession();let calls=0;
        session.callGameData=async()=>{calls++;return {NextActionInfo:{nextAction:'PICK'},Match3Result:{revealedSymbols:revealed}};};
        await assert.rejects(captureAGRound(session),/AG integrity:/);assert.equal(calls,1);
    });
}
test('其他游戏不套用 Triple Supreme Pick 协议',()=>{
    assert.equal(makeSession('rgp-game-other').getPickProtocol('PICK_FREE_SPINS',{}),undefined);
    assert.equal(makeSession().getPickProtocol('PICK_GOLD_COIN',{}),undefined);
});

test('同一大局再次免费选择仅预留一次配额，保留首次逻辑选项',async()=>{
    const session=makeSession();let calls=0, reservations=0;const picks:string[]=[];
    session.callGameData=async(event,parameters)=>{calls++;
        if(calls===1)return {NextActionInfo:{nextAction:'PICK_FREE_SPINS'}};
        if(calls===2||calls===4){assert.equal(event,'pickfreespins');picks.push(parameters!.pickIndex);return {NextActionInfo:{nextAction:'FREE_SPIN'}};}
        assert.equal(event,'freeSpin');return {NextActionInfo:{nextAction:calls===3?'PICK_FREE_SPINS':'SPIN'},PlayerBalanceInfo:{resultAmount:1}};
    };
    const round=await captureAGRound(session,{chooseOption:options=>{reservations++;return options[2];}});
    assert.equal(reservations,1);assert.equal(round.optionIndex,3);assert.equal(round.optionCount,4);
    assert.deepEqual(picks,['2','0']);assert.equal(calls,5);
});

for (const artifact of artifacts) {
    test(artifact+' 普通入口无历史数组，连续揭示保留已选位置且新板重置',async()=>{
        const session=makeSession(artifact);const calls:Array<{event:string;parameters:Record<string,any>|null}>=[];
        const response=(action:string,extra={})=>({NextActionInfo:{nextAction:action},...extra});
        const trigger=response('PICK',{PlayerBalanceInfo:{wager:0.4,preWagerBalance:100,balance:99.6}});
        session.callGameData=async(event,parameters)=>{calls.push(structuredClone({event,parameters}));
            if(calls.length===1)return trigger;
            if(calls.length===2){assert.deepEqual({event,parameters},{event:'Pick',parameters:{pickIndex:'0'}});return response('PICK',{Match3Result:{lastRevealedSymbol:{pickIndex:0}}});}
            if(calls.length===3){assert.deepEqual({event,parameters},{event:'Pick',parameters:{pickIndex:'1'}});return response('FREE_SPIN');}
            if(calls.length===4){assert.equal(event,'freeSpin');return response('PICK',{Match3Result:{}});}
            assert.equal(calls.length,5);assert.deepEqual({event,parameters},{event:'Pick',parameters:{pickIndex:'0'}});
            return response('SPIN',{PlayerBalanceInfo:{resultAmount:2,balance:101.6}});
        };
        session.getLastGameRequest=()=>calls[calls.length-1];
        const round=await captureAGRound(session);
        assert.equal(round.win,2);assert.equal(round.bet,0.4);assert.equal(round.isFeature,true);assert.equal(round.optionIndex,0);
        assert.deepEqual(round.data.roundTrigger,trigger);assert.deepEqual(round.data.roundEvents,calls.map(c=>c.event));
        assert.doesNotThrow(()=>validateReplaySequence(round.data));
    });
}
test('服务器历史在后续响应省略时仍保留，不只记本地点击',async()=>{
    const session=makeSession();let calls=0;
    session.callGameData=async(event,parameters)=>{calls++;
        if(calls===1)return {NextActionInfo:{nextAction:'PICK'},Match3Result:{revealedSymbols:[{pickIndex:0},{pickIndex:2}]}};
        assert.equal(event,'Pick');assert.deepEqual(parameters,{pickIndex:calls===2?'1':'3'});
        return {NextActionInfo:{nextAction:calls===2?'PICK':'SPIN'},PlayerBalanceInfo:{resultAmount:1}};
    };
    await captureAGRound(session);assert.equal(calls,3);
});
test('持续缺少服务器历史仍在12格耗尽时致命停止',async()=>{
    const session=makeSession();let calls=0;
    session.callGameData=async(event,parameters)=>{calls++;if(calls>1){assert.equal(event,'Pick');assert.deepEqual(parameters,{pickIndex:String(calls-2)});}return {NextActionInfo:{nextAction:'PICK'}};};
    await assert.rejects(captureAGRound(session),/AG integrity:/);assert.equal(calls,13);
});
