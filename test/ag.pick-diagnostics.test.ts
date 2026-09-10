import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession} from '../src/ag.client';
test('拒绝诊断仅记录安全索引且不吞错误',async(t)=>{
 const s:any=new RoxorCometDSession({gameId:'test',name:'test'});let calls=0;
 s.callGameRaw=async()=>({data:{responseText:JSON.stringify(++calls===1?{NextActionInfo:{nextAction:'PICK'},JackpotPickResultInfo:{revealedSymbols:[{pickIndex:0},{pickIndex:3},{pickIndex:'secret'},{pickIndex:-1}]}}:{ErrorInfo:{type:'MalformedRequest',detail:'secret'}})}});
 const logs:string[]=[];t.mock.method(console,'error',(v:unknown)=>logs.push(String(v)));
 await s.callGameData('Spin',{});await assert.rejects(s.callGameData('Pick',{pickIndex:'3',token:'secret'}));
 const d=JSON.parse(logs[0].slice('[AG-REJECT] '.length));
 assert.equal(d.pickIndex,'3');assert.equal(d.pickIndexType,'string');assert.deepEqual(d.previousRevealedIndexes,[0,3]);assert.ok(!logs[0].includes('secret'));
});
