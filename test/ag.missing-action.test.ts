import test from 'node:test';
import assert from 'node:assert/strict';
import {captureAGRound, AGInitialSpinRuntimeError} from '../src/ag.round';
import {isDeterministicCaptureError} from '../src/ag.scheduler';
for(const followUp of [false,true])for(const nextAction of [undefined,'','   ']){
    test('缺少下一动作明确阻断并保留脱敏上下文 '+followUp+' '+JSON.stringify(nextAction),async()=>{
        const calls:string[]=[];
        const session={getSpinParams:()=>({}),getPickParams:()=>({}),getFallbackBet:()=>1,
            callGameData:async(event:string)=>{calls.push(event);
                if(followUp&&calls.length===1)return {NextActionInfo:{nextAction:'NEXT_TRAIN'}};
                return {NextActionInfo:{nextAction},PlayerBalanceInfo:{wager:1,resultAmount:0},privateValue:'must-not-leak'};
            }};
        await assert.rejects(captureAGRound(session),(error:unknown)=>{
            assert.ok(error instanceof Error);assert.ok(!(error instanceof AGInitialSpinRuntimeError));
            assert.match(error.message,/AG integrity: missing nextAction/);assert.match(error.message,/PlayerBalanceInfo/);
            assert.match(error.message,followUp?/nexttrain/:/Spin/);assert.ok(!error.message.includes('must-not-leak'));
            assert.ok(isDeterministicCaptureError(error));return true;
        });
        assert.deepEqual(calls,followUp?['Spin','nexttrain']:['Spin']);
    });
}
