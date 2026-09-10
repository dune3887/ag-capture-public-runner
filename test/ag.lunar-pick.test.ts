import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession} from '../src/ag.client';
import {captureAGRound} from '../src/ag.round';
import {validateReplaySequence} from '../src/ag.mongo';
const session=()=>new RoxorCometDSession({gameId:'test',name:'test',backendArtifactId:'rgp-game-gold-stacks-88-lunar-festival'});
test('Lunar 免费选择使用1..5协议ID，忽略旧奖池字段',()=>{
 const p=session().getPickProtocol('PICK',{NextActionInfo:{id:'FREE_GAME_PICK'},JackpotPickResultInfo:{revealedSymbols:Array.from({length:12},(_,pickIndex)=>({pickIndex}))}})!;
 assert.equal(p.kind,'choice');assert.deepEqual(p.options.map(o=>o.requestPickIndex),[1,2,3,4,5]);assert.equal(p.remapReveal,undefined);
 assert.throws(()=>session().getPickProtocol('PICK',{NextActionInfo:{id:'UNKNOWN'}}),/unknown Lunar Pick branch/);
});
for(const choice of [1,2,3,4,5])test('Lunar 奖池后免费选择 '+choice+' 不继承揭示索引',async()=>{
 const s=session();let calls=0;
 const frame=(action:string,id?:string)=>({NextActionInfo:{nextAction:action,id},PlayerBalanceInfo:{wager:1,balance:99,resultAmount:0},JackpotPickResultInfo:{revealedSymbols:[9,10,11].map(pickIndex=>({pickIndex,prizeType:'MINI'}))}});
 (s as any).callGameData=async(event:string,params:any)=>{
  calls++;if(calls===1)return frame('PICK','JACKPOT');
  assert.equal(event,'Pick');assert.deepEqual(params,{pickIndex:String(calls===2?0:choice)});
  return calls===2?frame('PICK','FREE_GAME_PICK'):frame('SPIN');
 };
 const r=await captureAGRound(s,{chooseOption:options=>options.find(o=>o.requestPickIndex===choice)!});
 validateReplaySequence(r.data);assert.equal(calls,3);const steps=r.data.freeChoiceSteps;
 assert.deepEqual(steps[0].selectableIndexes,[]);assert.deepEqual(steps[1].selectableIndexes,[1,2,3,4,5]);
});
