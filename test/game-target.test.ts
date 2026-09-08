import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGameTargets, resolveGameTarget } from '../scripts/game-target';

test('resolves only the canonical game and database pair', () => {
    const games = loadGameTargets('ag-games.yml');
    const target = resolveGameTarget(
        games,
        'play-mo-mummy-mighty-pyramid',
        'ag_MoMummyMightyPyramid',
    );

    assert.equal(target.dbName, 'ag_MoMummyMightyPyramid');
    assert.throws(() => resolveGameTarget(games, 'missing', 'ag_Missing'), /unknown game id/);
    assert.throws(
        () => resolveGameTarget(games, target.gameId, 'ag_Buffalo'),
        /database mismatch/,
    );
});

test('rejects a manifest entry outside the canonical AG namespace', () => {
    const games = loadGameTargets('ag-games.yml');
    const unsafe = [{ ...games[1], dbName: 'db_other' }];

    assert.throws(
        () => resolveGameTarget(unsafe, unsafe[0].gameId, 'db_other'),
        /unsafe AG database name/,
    );
});
