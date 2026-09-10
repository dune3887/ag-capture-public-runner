import { ManifestGame, resolveGameTarget } from './game-target';

export interface RollingGame {
    gameId: string;
    dbName: string;
    campaignId: string;
    baseline: number;
    mongoUri: string;
}
export interface RollingPayload { version: 1; queueId: string; games: RollingGame[] }
export type TaskKind = 'worker' | 'canary';
export const LANES = 20;
export const TARGET = 300_000;
const safeId = /^[A-Za-z0-9._-]{1,100}$/;

export function taskId(kind: TaskKind, index: number): string {
    if (!['worker', 'canary'].includes(kind) || !Number.isInteger(index)
        || index < 1 || index > (kind === 'worker' ? LANES : 2)) throw new Error('invalid rolling task');
    return `${kind}:${index}`;
}

export function validateRollingPayload(value: unknown, manifest: ManifestGame[]): RollingPayload {
    const payload = value as RollingPayload;
    if (payload?.version !== 1 || typeof payload.queueId !== 'string' || !safeId.test(payload.queueId)
        || !Array.isArray(payload.games) || !payload.games.length || payload.games.length > manifest.length) {
        throw new Error('invalid rolling payload');
    }
    const ids = new Set<string>();
    const databases = new Set<string>();
    const campaigns = new Set<string>();
    for (const game of payload.games) {
        if (!game || typeof game.gameId !== 'string' || typeof game.dbName !== 'string'
            || typeof game.campaignId !== 'string' || !safeId.test(game.campaignId)
            || !Number.isInteger(game.baseline) || game.baseline < 0 || game.baseline >= 270_000
            || typeof game.mongoUri !== 'string') throw new Error('invalid rolling game');
        resolveGameTarget(manifest, game.gameId, game.dbName);
        if (ids.has(game.gameId) || databases.has(game.dbName) || campaigns.has(game.campaignId)) {
            throw new Error('duplicate rolling game or campaign');
        }
        ids.add(game.gameId); databases.add(game.dbName); campaigns.add(game.campaignId);
        // 不在验证异常中输出原 URI；凭据必须只授权对应游戏库。
        try {
            const uri = new URL(game.mongoUri);
            const authSources = [...uri.searchParams].filter(([key]) => key.toLowerCase() === 'authsource');
            if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol)
                || !/^agcap_[A-Za-z0-9_-]+$/.test(decodeURIComponent(uri.username)) || !uri.password
                || !uri.hostname || uri.hash || decodeURIComponent(uri.pathname) !== `/${game.dbName}`
                || authSources.length !== 1 || authSources[0][0] !== 'authSource'
                || authSources[0][1] !== game.dbName) throw new Error();
        } catch { throw new Error('invalid scoped Mongo credential'); }
    }
    return payload;
}
