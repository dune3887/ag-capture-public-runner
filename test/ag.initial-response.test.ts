import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResponseText, RoxorCometDSession} from '../src/ag.client';
import {captureAGRound, AGProviderResponseError, AGInitialSpinResponseError} from '../src/ag.round';
import {isDeterministicCaptureError} from '../src/ag.scheduler';

for (const payload of [{ErrorInfo:{type:'MalformedRequest'}},{error:{token:'must-not-leak'}}]) {
    for (const followUp of [false,true]) {
        test(`provider error discards error-only and blocks MalformedRequest: ${Object.keys(payload)[0]} followUp=${followUp}`,async()=>{
            let calls=0;
            const session={getSpinParams:()=>({}),getPickParams:()=>({}),getFallbackBet:()=>1,
                callGameData:async(event:string)=>{
                    if(followUp && ++calls===1)return {NextActionInfo:{nextAction:'NEXT_TRAIN'}};
                    return parseResponseText({channel:'/service/game',data:{responseText:JSON.stringify(payload)}},event);
                }};
            await assert.rejects(captureAGRound(session),(error:unknown)=>{
                assert.ok(error instanceof Error);
                assert.equal(error instanceof AGInitialSpinResponseError,!followUp && 'error' in payload);
                assert.equal(isDeterministicCaptureError(error),'ErrorInfo' in payload);
                assert.ok(!error.message.includes('must-not-leak'));
                return true;
            });
        });
    }
}
test('mixed error payload is not treated as a disposable error-only response',()=>{
    const value={error:'untrusted',PlayerBalanceInfo:{wager:1}};
    assert.deepEqual(parseResponseText({channel:'/service/game',data:{responseText:JSON.stringify(value)}},'Spin'),value);
});
test('non-Spin initial requests remain fatal for provider error',async()=>{
    const session={getInitialRoundRequest:()=>({event:'Wager',parameters:{}}),getSpinParams:()=>({}),getPickParams:()=>({}),getFallbackBet:()=>1,
        callGameData:async()=>{throw new AGProviderResponseError('Wager','MalformedRequest');}};
    await assert.rejects(captureAGRound(session),(e:unknown)=>isDeterministicCaptureError(e));
});

test('Wicked Spin matches official two-field request even with cached symbols',()=>{
    const session=new RoxorCometDSession({gameId:'play-wicked-winnings-ii',name:'Wicked',backendArtifactId:'rgp-game-wicked-winnings-2'});
    Object.assign(session,{coinSize:'0.05',numberOfCoins:'1,1',activeSymbols:{stale:true}});
    assert.deepEqual(session.getSpinParams(),{coinSize:'0.05',numberOfCoins:'1,1'});
});
test('MalformedRequest records safe request context and stays fatal',async(t)=>{
    const session:any=new RoxorCometDSession({gameId:'play-wicked-winnings-ii',name:'Wicked',backendArtifactId:'rgp-game-wicked-winnings-2'});
    let calls=0;session.callGameRaw=async()=>({channel:'/service/game',data:{responseText:JSON.stringify(++calls===1?{NextActionInfo:{nextAction:'SPIN'},PlayerBalanceInfo:{balance:100}}:{ErrorInfo:{type:'MalformedRequest',privateValue:'must-not-leak'}})}});
    const logs:string[]=[];t.mock.method(console,'error',(value:unknown)=>logs.push(String(value)));
    await session.callGameData('Spin',{coinSize:'0.04',numberOfCoins:'1,1'});
    await assert.rejects(session.callGameData('Spin',{coinSize:'0.04',numberOfCoins:'1,1',token:'must-not-leak'}),(e:unknown)=>isDeterministicCaptureError(e));
    assert.equal(logs.length,1);assert.ok(!logs[0].includes('must-not-leak'));
    const detail=JSON.parse(logs[0].slice('[AG-REJECT] '.length));
    assert.equal(detail.protocol,'standard');
    assert.equal(detail.requestTrail.length,1);
    assert.equal(detail.requestTrail[0].event,'Spin');
    assert.equal(detail.requestTrail[0].nextAction,'SPIN');
    assert.equal(detail.previousAction,'SPIN');assert.equal(detail.previousBalance,100);
    assert.equal(detail.coinSize,'0.04');assert.equal(detail.numberOfCoins,'1,1');assert.equal(detail.completedRequests,1);
});
