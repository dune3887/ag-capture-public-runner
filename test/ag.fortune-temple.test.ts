import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession} from '../src/ag.client';
import {captureAGRound} from '../src/ag.round';
import {validateReplaySequence,buildMongoDoc} from '../src/ag.mongo';
const session=(id='rgp-game-fortunetemple')=>new RoxorCometDSession({gameId:'test',name:'test',backendArtifactId:id});
const frame=(action:string,win=0)=>({NextActionInfo:{nextAction:action},PlayerBalanceInfo:{balance:99+win,wager:1,resultAmount:win}});
function mock(terminal='SPIN') {const s=session();let calls=0;(s as any).callGameData=async(event:string,params:any)=>{calls++;if(calls===1)return {...frame('PICK'),GameWageringInfo:{currentCoinSize:1},PickGameInfo:{requestMode:'legacy-stateful-spin-pick',requestEvent:'Pick'}};assert.equal(event,'Pick');assert.deepEqual(params,{pickIndex:calls===2?'0':'-1'});return calls===2?{...frame('PICK'),XmlEvents:{PickItemEvent:{isLast:'true',PickItem:[{type:'WIN',value:3},{type:'COLLECT'}]}}}:frame(terminal,3)};return s;}
test('Fortune Temple COLLECT 后请求 -1 并录制真实结算',async()=>{const r=await captureAGRound(mock());assert.equal(r.data.requiresSessionReset,false);assert.equal(r.win,3);validateReplaySequence(r.data);buildMongoDoc(r);const steps=r.data.freeChoiceSteps;assert.equal(steps.length,2);assert.deepEqual(steps[1].parameters,{pickIndex:'-1'});assert.equal(steps[1].requiresPickIndex,false);assert.equal(steps[1].data.NextActionInfo.nextAction,'SPIN');});
test('Fortune Temple 结算未到终局拒绝入库',async()=>{await assert.rejects(captureAGRound(mock('PICK')),/completion did not terminate/)});
test('Fortune Temple 自动结算也受步骤上限保护',async()=>{await assert.rejects(captureAGRound(mock(),{maxSteps:1}),/completion step limit/)});
test('收尾协议仅用于 Fortune Temple stateful 转盘',()=>{assert.equal(session('other').getLegacyPickCompletionRequest('legacy-stateful-spin-pick'),undefined);for(const mode of ['legacy-preloaded-pick','legacy-multiround-pick'])assert.equal(session().getLegacyPickCompletionRequest(mode),undefined);});
