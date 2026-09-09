import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import yaml from 'js-yaml';

const workflowPath = '.github/workflows/capture-ag-game.yml';

test('workflow is manual-only and runs fifty isolated workers', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const parsed = yaml.load(workflow) as {
        on: Record<string, unknown>;
        permissions: Record<string, unknown>;
        jobs: Record<string, { strategy?: Record<string, unknown> }>;
    };

    assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch']);
    assert.equal(parsed.permissions.contents, 'read');
    assert.equal(parsed.jobs.capture.strategy?.['max-parallel'], 50);
    assert.equal(parsed.jobs.canary.strategy?.['max-parallel'], 2);
    assert.match(workflow, /github\.repository == 'dune3887\/ag-capture-public-runner'/);
});

test('workflow requires the canonical game and database pair in every job', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /game_id:/);
    assert.match(workflow, /db_name:/);
    assert.match(workflow, /TARGET_GAME_ID:\s*\$\{\{ inputs\.game_id \}\}/);
    assert.match(workflow, /TARGET_DB:\s*\$\{\{ inputs\.db_name \}\}/);
    assert.match(workflow, /ONLY_GAME:\s*\$\{\{ inputs\.game_id \}\}/);
    assert.match(workflow, /npm run campaign -- validate-target/);
});

test('worker and canary collection names include the selected database', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(
        workflow,
        /AG_SIMULATE_COLLECTION:\s*simulate_gh_\$\{\{ inputs\.db_name \}\}_\$\{\{ inputs\.resume_campaign_id \|\| github\.run_id \}\}_worker_/,
    );
    assert.match(
        workflow,
        /AG_SIMULATE_COLLECTION:\s*simulate_gh_\$\{\{ inputs\.db_name \}\}_\$\{\{ github\.run_id \}\}_canary_/,
    );
});

test('workflow never contains a database URI or admin operation', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /MONGO_URI:\s*\$\{\{ secrets\.MONGO_URI \}\}/);
    assert.doesNotMatch(workflow, /mongodb(?:\+srv)?:\/\//i);
    assert.doesNotMatch(workflow, /createUser|dropUser|userAdmin|root/i);
});
