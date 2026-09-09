import os from 'os';

function numberEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveNumberEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Base rounds target per worker staging collection.
export const SPIN_LIMIT = numberEnv('SPIN_LIMIT', 10);
export const VALIDATION_SAMPLES = numberEnv('AG_VALIDATION_SAMPLES', 0);
export const FREE_CHOICE_PER_OPTION = numberEnv('FREE_CHOICE_PER_OPTION', 0);
export const MAX_ROUNDS_PER_GAME = numberEnv('MAX_ROUNDS_PER_GAME', numberEnv('MAX_ROUNDS', 0));

export const RETRY_ATTEMPTS = numberEnv('RETRY_ATTEMPTS', 5);
export const RETRY_DELAY_MS = numberEnv('RETRY_DELAY_MS', 2000);
export const SPIN_DELAY_MS = numberEnv('SPIN_DELAY_MS', 200);
export const LOG_INTERVAL = numberEnv('LOG_INTERVAL', 100);

export const CONCURRENT_GAMES = 1;
export const CONCURRENT_PER_GAME = 1;
export const SESSION_READY_DELAY_MS = numberEnv('SESSION_READY_DELAY_MS', 250);
export const SESSION_RECYCLE_DELAY_MS = numberEnv('SESSION_RECYCLE_DELAY_MS', 1000);
export const WORKER_START_JITTER_MS = 0;
export const CAPTURE_OWNER_ID = process.env.CAPTURE_OWNER_ID
    || `${os.hostname()}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const GAME_LEASE_MS = numberEnv('GAME_LEASE_MS', 90 * 1000);
export const GAME_LEASE_RENEW_MS = numberEnv('GAME_LEASE_RENEW_MS', 20 * 1000);
export const CAPTURE_LEASE_ID = String(process.env.CAPTURE_LEASE_ID || 'ag_capture_game').trim();

export const TEST_RTP = process.env.TEST_RTP !== '0';
export const MONGO_URI = String(process.env.MONGO_URI || '').trim();
export const MONGO_MAX_POOL_SIZE = positiveNumberEnv('MONGO_MAX_POOL_SIZE', 2);
export const MONGO_SERVER_SELECTION_TIMEOUT_MS = positiveNumberEnv('MONGO_SERVER_SELECTION_TIMEOUT_MS', 60_000);
export const MONGO_CONNECT_TIMEOUT_MS = positiveNumberEnv('MONGO_CONNECT_TIMEOUT_MS', 30_000);

// DraftKings / Pariplay-Roxor launch parameters.
export const PARIPLAY_LAUNCH_ENDPOINT = 'https://hubgamesnj.pariplaygames.com/api/LaunchGameDraftKings';
export const ROXOR_GS_WRAPPER_BASE = 'https://cdn-pariplay.us-nj.roxor.games/static-assets/gs-wrapper/load';
export const DEFAULT_BRAND_ID = process.env.DEFAULT_BRAND_ID || 'DKNJ';
export const DEFAULT_WEBSITE = process.env.DEFAULT_WEBSITE || 'dfkj';
export const DEFAULT_PLATFORM = process.env.DEFAULT_PLATFORM || 'Desktop';
export const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'en';
export const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'USD';
export const DEFAULT_MODE = process.env.DEFAULT_MODE || 'Demo';
export const ARISTOCRAT_GAMEID_PREFIX = 'ART_';
