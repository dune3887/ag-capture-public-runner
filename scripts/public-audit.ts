import { execFileSync } from 'child_process';
import fs from 'fs';

const exactAllowed = new Set([
    '.github/workflows/capture-ag-game.yml',
    '.github/workflows/capture-ag-rolling.yml',
    '.gitignore',
    'README.md',
    'ag-games.yml',
    'ag.ts',
    'config.ts',
    'package-lock.json',
    'package.json',
    'scripts/campaign.ts',
    'scripts/game-target.ts',
    'scripts/rolling-contract.ts',
    'scripts/rolling-worker.ts',
    'scripts/public-audit.ts',
    'tsconfig.json',
]);

const allowedPatterns = [
    /^src\/ag\.[a-z]+\.ts$/,
    /^test\/[a-z0-9.-]+\.test\.ts$/,
];

const sensitivePatterns = [
    /mongodb(?:\+srv)?:\/\/[^/\s:@]+:[^@\s]+@/i,
    /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/i,
];

function git(args: string[]): string {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listLines(value: string): string[] {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function assertAllowed(files: string[]): void {
    const unexpected = files.filter((file) => (
        !exactAllowed.has(file) && !allowedPatterns.some((pattern) => pattern.test(file))
    ));
    if (unexpected.length > 0) throw new Error(`unexpected public files: ${unexpected.join(', ')}`);
}

function scanRevision(revision: string): void {
    const files = listLines(git(['ls-tree', '-r', '--name-only', revision]));
    assertAllowed(files);
    for (const file of files) {
        if (file === 'package-lock.json') continue;
        const content = git(['show', `${revision}:${file}`]);
        for (const pattern of sensitivePatterns) {
            if (pattern.test(content)) throw new Error(`sensitive pattern in ${revision}:${file}`);
        }
    }
}

function assertContentClean(content: string, location: string): void {
    for (const pattern of sensitivePatterns) {
        if (pattern.test(content)) throw new Error(`sensitive pattern in ${location}`);
    }
}

const tracked = listLines(git(['ls-files']));
const publishable = listLines(git(['ls-files', '--cached', '--others', '--exclude-standard']));
assertAllowed(publishable);
for (const file of publishable) {
    if (file !== 'package-lock.json') assertContentClean(fs.readFileSync(file, 'utf8'), `working-tree:${file}`);
}
for (const revision of listLines(git(['rev-list', '--all']))) scanRevision(revision);
console.log(`[public-audit] tracked=${tracked.length} publishable=${publishable.length} revisions=${listLines(git(['rev-list', '--all'])).length} clean=true`);
