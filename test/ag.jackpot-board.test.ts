import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession} from '../src/ag.client';
import {captureAGRound} from '../src/ag.round';
import {validateReplaySequence} from '../src/ag.mongo';
for (const game of ['turtle-kingdom','dancing-foo']) {
 const session=()=>new RoxorCometDSession({gameId:'test',name:'test',backendArtifactId:'rgp-game-gold-stacks-88-'+game});
 test(game+'仅按当前盘面选未揭示格，不沿用上一盘历史',()=>{
  const s=session(); const p=s.getPickProtocol('PICK',{JackpotPickResultInfo:{revealedSymbols:[9,10,11].map(pickIndex=>({pickIndex}))}},Array.from({length:12},(_,i)=>i))!;
  assert.equal(p.event,'Pick');assert.equal(p.options[0].requestPickIndex,0);assert.equal(p.remapReveal,true);
  for(const revealed of [[{pickIndex:12}],[{pickIndex:-1}],[{pickIndex:0},{pickIndex:0}],[{pickIndex:''}],null])assert.throws(()=>s.getPickProtocol('PICK',{JackpotPickResultInfo:{revealedSymbols:revealed}}),/AG integrity/);
  assert.equal(s.getPickProtocol('PICK',{} )!.options.length,12);
 });
 test(game+'同一大局五次奖池重置，精确请求且保留自由点击回放',async()=>{
  const s=session();let board=0,picked:number[]=[];const calls:any[]=[];
  const frame=(action:string,extra:any={})=>({NextActionInfo:{nextAction:action},PlayerBalanceInfo:{wager:1,balance:99,resultAmount:0},...extra});
  (s as any).callGameData=async(event:string,params:any)=>{
   if(event==='Spin')return frame('PICK');
   if(event==='freeSpin'){picked=[];return frame('PICK');}
   assert.equal(event,'Pick');assert.deepEqual(params,{pickIndex:String(picked.length)});calls.push(params);picked.push(Number(params.pickIndex));
   const done=picked.length===3;if(done)board++;
   return frame(done?(board===5?'SPIN':'FREE_SPIN'):'PICK',{JackpotPickResultInfo:{revealedSymbols:picked.map(pickIndex=>({pickIndex,prizeType:'MINI'}))}});
  };
  const result=await captureAGRound(s);assert.equal(calls.length,15);validateReplaySequence(result.data);
  const steps=result.data.freeChoiceSteps.filter((x:any)=>x.event==='Pick');assert.equal(steps.length,15);
  for(const step of steps){assert.deepEqual(step.selectableIndexes,[]);assert.equal(step.requiresPickIndex,true);}
 });
 test(game+'全盘揭示仍PICK立即失败，不发送越界请求',async()=>{
  const s=session();let calls=0;(s as any).callGameData=async()=>{calls++;return {NextActionInfo:{nextAction:'PICK'},PlayerBalanceInfo:{wager:1,balance:99,resultAmount:0},JackpotPickResultInfo:{revealedSymbols:Array.from({length:12},(_,pickIndex)=>({pickIndex}))}};};
  await assert.rejects(captureAGRound(s),/no selectable option/);assert.equal(calls,1);
 });
}
