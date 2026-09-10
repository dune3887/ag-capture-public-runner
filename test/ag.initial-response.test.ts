import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResponseText, RoxorCometDSession} from '../src/ag.client';
import {captureAGRound, AGProviderResponseError, AGInitialSpinResponseError} from '../src/ag.round';
import {isDeterministicCaptureError} from '../src/ag.scheduler';

for (const payload of [{ErrorInfo:{type:'MalformedRequest'}},{error:{token:'must-not-leak'}}]) {
    for (const followUp of [false,true]) {
        test(`provider error resets only initial Spin: ${Object.keys(payload)[0]} followUp=${followUp}`,async()=>{
            let calls=0;
            const session={getSpinParams:()=>({}),getPickParams:()=>({}),getFallbackBet:()=>1,
                callGameData:async(event:string)=>{
                    if(followUp && ++calls===1)return {NextActionInfo:{nextAction:'NEXT_TRAIN'}};
                    return parseResponseText({channel:'/service/game',data:{responseText:JSON.stringify(payload)}},event);
                }};
            await assert.rejects(captureAGRound(session),(error:unknown)=>{
                assert.ok(error instanceof Error);
                assert.equal(error instanceof AGInitialSpinResponseError,!followUp);
                assert.equal(isDeterministicCaptureError(error),followUp);
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
