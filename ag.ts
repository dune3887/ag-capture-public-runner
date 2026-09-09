#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
    CAPTURE_OWNER_ID,
    CONCURRENT_GAMES,
    CONCURRENT_PER_GAME,
    FREE_CHOICE_PER_OPTION,
    GAME_LEASE_MS,
    GAME_LEASE_RENEW_MS,
    LOG_INTERVAL,
    MAX_ROUNDS_PER_GAME,
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
    SESSION_READY_DELAY_MS,
    SESSION_RECYCLE_DELAY_MS,
    SPIN_DELAY_MS,
    SPIN_LIMIT,
    VALIDATION_SAMPLES,
    WORKER_START_JITTER_MS,
} from './config';
import { applyGameShard } from './src/ag.plan';
import { AGMongoStore } from './src/ag.mongo';
import { runAGScheduler } from './src/ag.scheduler';
import { AGGameConfig } from './src/ag.types';

interface AGGamesFile {
    games: AGGameConfig[];
}

interface RuntimeGameEntry {
    dbName?: string;
    serviceDir?: string;
}

function parseNumberArg(names: string[], fallback: number): number {
    for (const name of names) {
        const arg = process.argv.find((item) => item.startsWith(`${name}=`));
        if (!arg) {
            continue;
        }

        const value = Number(arg.slice(name.length + 1).trim());
        if (Number.isFinite(value) && value >= 0) {
            return value;
        }
    }

    return fallback;
}

function parseCsvArg(name: string): Set<string> {
    const arg = process.argv.find((item) => item.startsWith(`${name}=`));
    return new Set(
        (arg ? arg.slice(name.length + 1) : '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
    );
}

function getFirstPositionalArg(): string {
    return process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '';
}

function loadGameDbNameMap(agGamesRoot: string): Map<string, RuntimeGameEntry> {
    const result = new Map<string, RuntimeGameEntry>();
    if (!fs.existsSync(agGamesRoot)) {
        return result;
    }

    for (const dirName of fs.readdirSync(agGamesRoot)) {
        if (!dirName.startsWith('ag_') || dirName === 'ag_template') {
            continue;
        }

        const gamePath = path.join(agGamesRoot, dirName, 'config', 'ag_game.json');
        const cfgPath = path.join(agGamesRoot, dirName, 'config', 'config.yaml');
        if (!fs.existsSync(gamePath) || !fs.existsSync(cfgPath)) {
            continue;
        }

        try {
            const gameCfg = JSON.parse(fs.readFileSync(gamePath, 'utf8'));
            const serviceCfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) as { dbName?: string };
            if (gameCfg?.gameId) {
                result.set(gameCfg.gameId, {
                    dbName: serviceCfg?.dbName || dirName,
                    serviceDir: dirName,
                });
            }
        } catch {
            // Some generated service dirs may be incomplete during local work.
        }
    }

    return result;
}

export function deriveAGDbName(gameId: string): string {
    const slug = gameId
        .trim()
        .replace(/^play-/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return `ag_${slug || 'game'}`;
}

export function loadGames(): AGGameConfig[] {
    const ymlPath = path.resolve(process.cwd(), 'ag-games.yml');
    if (!fs.existsSync(ymlPath)) {
        throw new Error(`missing ${ymlPath}`);
    }

    const agGamesRoot = process.env.AG_GAMES_ROOT || path.resolve(process.cwd(), '../../..', 'aggames');
    const dbNameMap = loadGameDbNameMap(agGamesRoot);
    const raw = fs.readFileSync(ymlPath, 'utf8');
    const doc = yaml.load(raw) as AGGamesFile;
    const games = Array.isArray(doc?.games) ? doc.games : [];
    let derivedDbNames = 0;

    const result = games.map((game) => {
        const runtime = dbNameMap.get(game.gameId) || {};
        const dbName = game.dbName || runtime.dbName || deriveAGDbName(game.gameId);
        if (!game.dbName && !runtime.dbName) {
            derivedDbNames += 1;
        }
        return {
            ...game,
            dbName,
            serviceDir: game.serviceDir || runtime.serviceDir,
        };
    });

    if (derivedDbNames > 0) {
        console.warn(
            `[config] ${derivedDbNames} AG games missing generated runtime dbName under ${agGamesRoot}; using derived ag_* db names`,
        );
    }

    return result;
}

function matchesGameFilter(game: AGGameConfig, filters: Set<string>): boolean {
    if (filters.size === 0) {
        return true;
    }

    const candidates = [
        game.gameId,
        game.name,
        game.dbName,
        game.serviceDir,
        game.backendId,
    ].filter(Boolean) as string[];
    return candidates.some((value) => filters.has(value));
}

async function main() {
    const shutdownController = new AbortController();
    let shutdownSignalName: NodeJS.Signals | null = null;
    const signalHandler = (signal: NodeJS.Signals) => {
        if (shutdownSignalName) {
            console.error(`[signal] ${signal} received again, forcing exit`);
            process.exit(130);
        }

        shutdownSignalName = signal;
        console.warn(`[signal] ${signal} received, stopping AG capture and releasing active game locks`);
        shutdownController.abort();
    };
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
    process.once('SIGHUP', signalHandler);

    const positional = getFirstPositionalArg();
    const gamesFilter = parseCsvArg('--games');
    const onlyGame = process.env.ONLY_GAME || positional;
    if (onlyGame) {
        gamesFilter.add(onlyGame);
    }

    const gameLimit = parseNumberArg(['--game-limit', '--limit'], Number(process.env.GAME_LIMIT || 0));
    const shardIndex = parseNumberArg(['--shard-index'], Number(process.env.CAPTURE_SHARD_INDEX || 1));
    const shardTotal = parseNumberArg(['--shard-total'], Number(process.env.CAPTURE_SHARD_TOTAL || 1));
    const shouldClear = process.env.CAPTURE_CLEAR === '1' || process.argv.includes('--clear');

    let games = loadGames().filter((game) => matchesGameFilter(game, gamesFilter));
    games = applyGameShard(games, shardIndex, shardTotal);
    if (gameLimit > 0) {
        games = games.slice(0, gameLimit);
    }

    if (!games.length) {
        console.log('no matching AG games found');
        return;
    }

    const store = new AGMongoStore();
    console.log(
        [
            `capture mode: AG auto-topup games=${games.length}`,
            `base=${VALIDATION_SAMPLES || SPIN_LIMIT}`,
            `freeChoicePerOption=${VALIDATION_SAMPLES || FREE_CHOICE_PER_OPTION}`,
            `validationSamples=${VALIDATION_SAMPLES}`,
            `concurrentGames=${CONCURRENT_GAMES}`,
            `workersPerGame=${CONCURRENT_PER_GAME}`,
            `shard=${shardIndex}/${shardTotal}`,
            `lease=${GAME_LEASE_MS}/${GAME_LEASE_RENEW_MS}`,
            `owner=${CAPTURE_OWNER_ID}`,
            `mongo=${store.getMongoTarget()}`,
            `collection=${store.getSimulateCollectionName()}`,
        ].join(' '),
    );

    try {
        await runAGScheduler(games, {
            store,
            limits: {
                spinLimit: VALIDATION_SAMPLES || SPIN_LIMIT,
                freeChoicePerOption: VALIDATION_SAMPLES || FREE_CHOICE_PER_OPTION,
            },
            validationSamples: VALIDATION_SAMPLES,
            concurrentGames: CONCURRENT_GAMES,
            workersPerGame: CONCURRENT_PER_GAME,
            retryAttempts: RETRY_ATTEMPTS,
            retryDelayMs: RETRY_DELAY_MS,
            spinDelayMs: SPIN_DELAY_MS,
            logInterval: LOG_INTERVAL,
            sessionReadyDelayMs: SESSION_READY_DELAY_MS,
            sessionRecycleDelayMs: SESSION_RECYCLE_DELAY_MS,
            workerStartJitterMs: WORKER_START_JITTER_MS,
            shouldClear,
            maxRoundsPerGame: MAX_ROUNDS_PER_GAME,
            ownerId: CAPTURE_OWNER_ID,
            gameLeaseMs: GAME_LEASE_MS,
            gameLeaseRenewMs: GAME_LEASE_RENEW_MS,
            shutdownSignal: shutdownController.signal,
        });
    } finally {
        process.off('SIGINT', signalHandler);
        process.off('SIGTERM', signalHandler);
        process.off('SIGHUP', signalHandler);
        await store.close();
        if (shutdownSignalName) {
            process.exitCode = shutdownSignalName === 'SIGINT' ? 130 : 143;
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`fatal: ${message}`);
        process.exit(1);
    });
}
