import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import yaml from 'js-yaml';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const workflowPath = '.github/workflows/capture-ag-game.yml';

test('workflow is manual-only and runs twenty isolated workers', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const parsed = yaml.load(workflow) as {
        on: Record<string, unknown>;
        permissions: Record<string, unknown>;
        env: Record<string, unknown>;
        jobs: Record<string, {
            strategy?: Record<string, unknown>;
            env?: Record<string, unknown>;
        }>;
    };

    assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch']);
    assert.equal(parsed.permissions.contents, 'read');
    assert.equal(parsed.env.WORKER_COUNT, '20');
    assert.equal(parsed.jobs.capture.strategy?.['max-parallel'], 20);
    assert.equal(parsed.jobs.canary.strategy?.['max-parallel'], 2);
    assert.equal(parsed.jobs.canary.env?.CONCURRENT_PER_GAME, '1');
    assert.equal(parsed.jobs.capture.env?.CONCURRENT_PER_GAME, '8');
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

for (const job of ['canary', 'capture']) {
    for (const [statuses, expectedExit, expectedCalls, diagnostic = false] of [
        ['1 0', 1, 1, true],
        ['78 0', 78, 1, true],
        ['0', 0, 1, true],
        ['78 0', 78, 1],
        ['1 78 0', 78, 2],
        ['1 0', 0, 2],
        ['1 1 0', 0, 3],
        ['1 1 1 0', 1, 3],
    ] as const) {
        test(`${job} retry shell handles statuses ${statuses} diagnostic=${diagnostic} without masking deterministic failure`, () => {
            const parsed = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as {
                jobs: Record<string, { steps: Array<{ shell?: string; run?: string }> }>;
            };
            const script = parsed.jobs[job].steps.find((step) => step.shell === 'bash' && step.run?.includes('npm run ag'))?.run;
            assert.ok(script, 'must execute the actual workflow retry shell');
            const bash = process.platform === 'win32'
                ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
                : 'bash';
            const result = spawnSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `
                export DIAGNOSTIC_ONLY=${diagnostic}
                statuses=(${statuses})
                calls=0
                npm() {
                    echo TEST_NPM_CALL
                    code="\${statuses[$calls]:-99}"
                    calls=$((calls + 1))
                    return "$code"
                }
                sleep() { :; }
                ${script}
            `], { encoding: 'utf8', timeout: 10000 });
            assert.equal(result.status, expectedExit, result.stderr || result.error?.message);
            assert.equal((result.stdout.match(/TEST_NPM_CALL/g) || []).length, expectedCalls);
        });
    }
}

test('diagnostic dispatch disables automatic merge and defaults off', () => {
    const parsed = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as any;
    assert.equal(parsed.on.workflow_dispatch.inputs.diagnostic_only.type, 'boolean');
    assert.equal(parsed.on.workflow_dispatch.inputs.diagnostic_only.default, false);
    assert.equal(parsed.env.DIAGNOSTIC_ONLY, '${{ inputs.diagnostic_only }}');
    assert.equal(parsed.jobs.finalize.if, "github.repository == 'dune3887/ag-capture-public-runner' && !inputs.diagnostic_only");
});
