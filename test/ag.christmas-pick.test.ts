import test from 'node:test';
import assert from 'node:assert/strict';
import {RoxorCometDSession} from '../src/ag.client';

test('Christmas Cottage 小写协议保留官方 PickRequest 参数', () => {
    const session = new RoxorCometDSession({gameId:'play-christmas-cottage',name:'Christmas Cottage',backendArtifactId:'rgp-game-christmas-cottage'});
    (session as any).protocol = 'lowercase-standard';
    assert.deepEqual(session.getPickParams('0'), {roundIndex:'0',pickIndex:'0',autoPick:'false'});
    assert.deepEqual(session.getPickParams('2'), {roundIndex:'0',pickIndex:'2',autoPick:'false'});
    assert.equal(session.getPickEvent(), 'PickRequest');
    const other = new RoxorCometDSession({gameId:'other',name:'other'});
    (other as any).protocol = 'lowercase-standard';
    assert.deepEqual(other.getPickParams('2'), {pickIndex:'2'});
});

test('Christmas PickRequest 不被小写协商改写', async () => {
    const session = new RoxorCometDSession({gameId:'play-christmas-cottage',name:'Christmas Cottage',backendArtifactId:'rgp-game-christmas-cottage'});
    (session as any).protocol = 'lowercase-standard';
    const calls: any[] = [];
    (session as any).callGameRaw = async (event: string, parameters: any) => {
        calls.push({event, parameters});
        return {data: {responseText: JSON.stringify({NextActionInfo:{nextAction:'FREE_SPIN'}})}};
    };
    await session.callGameData(session.getPickEvent(), session.getPickParams('4'));
    assert.deepEqual(calls, [{event:'PickRequest',parameters:{roundIndex:'0',pickIndex:'4',autoPick:'false'}}]);
});
