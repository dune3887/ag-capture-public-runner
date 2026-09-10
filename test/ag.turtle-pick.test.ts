import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession} from '../src/ag.client';
test('Turtle奖池使用官方大写Pick与纯字符串索引',async()=>{
 const s=new RoxorCometDSession({gameId:'test',name:'test',backendArtifactId:'rgp-game-gold-stacks-88-turtle-kingdom'});
 assert.equal(s.getPickEvent(),'Pick');assert.deepEqual(s.getPickParams(0),{pickIndex:'0'});assert.deepEqual(s.getPickParams(7),{pickIndex:'7'});
 const calls:any[]=[];
 (s as any).callGameRaw=async(event:string,parameters:any)=>{calls.push({event,parameters});return {data:{responseText:JSON.stringify({NextActionInfo:{nextAction:'SPIN'}})}};};
 await s.callGameData(s.getPickEvent(),s.getPickParams(3));
 assert.deepEqual(calls,[{event:'Pick',parameters:{pickIndex:'3'}}]);
 const other=new RoxorCometDSession({gameId:'other',name:'other'});assert.equal(other.getPickEvent(),'');
});
