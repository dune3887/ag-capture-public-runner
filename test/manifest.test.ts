import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import yaml from 'js-yaml';

interface ManifestGame {
    gameId: string;
    name: string;
    dbName: string;
    serviceDir: string;
    backendId?: string;
    backendArtifactId?: string;
}

test('public manifest contains exactly the 92 canonical AG games', () => {
    const manifest = yaml.load(fs.readFileSync('ag-games.yml', 'utf8')) as { games: ManifestGame[] };
    const games = manifest.games;

    assert.equal(games.length, 92);
    assert.equal(new Set(games.map((game) => game.gameId)).size, 92);
    assert.equal(new Set(games.map((game) => game.dbName)).size, 92);
    for (const game of games) {
        assert.match(game.dbName, /^ag_[A-Za-z0-9]+$/);
        assert.equal(game.serviceDir, game.dbName);
        assert.ok(game.backendId);
        assert.ok(game.backendArtifactId);
    }
    assert.equal(games[1].gameId, 'play-mo-mummy-mighty-pyramid');
    assert.equal(games[1].dbName, 'ag_MoMummyMightyPyramid');
});
