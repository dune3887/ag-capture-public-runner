import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession} from '../src/ag.client';
import {captureAGRound, AGProviderResponseError} from '../src/ag.round';
import {validateReplaySequence} from '../src/ag.mongo';

const client = () => new RoxorCometDSession({gameId:'play-secrets-of-the-phoenix-blaze',name:'Blaze'});
test('Blaze使用官方固定事件和空参数，其他游戏不套用', () => {
    const s=client();
    for(const [action,event] of Object.entries({SPIN:'Spin',FREE_SPIN:'FreeSpin',CASCADE_SPIN:'Cascade',FREE_CASCADE:'FreeCascade'}))
        assert.deepEqual(s.getExactFollowUpRequest(action),{event,parameters:{}});
    assert.equal(new RoxorCometDSession({gameId:'play-more-chilli',name:'More Chilli'}).getExactFollowUpRequest('FREE_SPIN'),undefined);
});
for(const rejected of [false,true]) test('Blaze完整免费级联回放及拒绝不重发 '+rejected,async()=>{
    const calls:string[]=[];const s=client();
    const session={
        getSpinParams:()=>({coinSize:'0.01',numberOfCoins:'1,1'}),getPickParams:()=>({}),getFallbackBet:()=>0.02,
        getInitialRoundRequest:()=>({event:'wager',parameters:{coinSize:'0.01',numberOfCoins:'1,1'}}),
        getExactFollowUpRequest:s.getExactFollowUpRequest.bind(s),
        getActionParams:()=>({}),isRoundTerminalAction:(a:string)=>a==='WAGER',
        callGameData:async(event:string,params:Record<string,any>|null)=>{
            calls.push(event);
            if(event==='wager')return {PlayerBalanceInfo:{wager:0.02},NextActionInfo:{nextAction:'SPIN'}};
            assert.deepEqual(params,{});
            if(event==='FreeSpin' && rejected) throw new AGProviderResponseError(event,'MalformedRequest');
            const actions:Record<string,string>={Spin:'FREE_SPIN',FreeSpin:'FREE_CASCADE',FreeCascade:'CASCADE_SPIN',Cascade:'WAGER'};
            if(!actions[event])throw Error('unexpected '+event);
            return {PlayerBalanceInfo:{resultAmount:0.1,balance:100.08},NextActionInfo:{nextAction:actions[event]}};
        }
    };
    if(rejected){await assert.rejects(captureAGRound(session),/MalformedRequest/);assert.deepEqual(calls,['wager','Spin','FreeSpin']);}
    else {const r=await captureAGRound(session);assert.deepEqual(calls,['wager','Spin','FreeSpin','FreeCascade','Cascade']);assert.equal(r.isFeature,true);assert.equal(r.data.roundTerminalAction,'WAGER');validateReplaySequence(r.data);}
});
