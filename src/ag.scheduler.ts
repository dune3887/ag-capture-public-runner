import { RoxorCometDSession } from './ag.client';
import {
    buildCaptureState,
    ensureChoiceTasks,
    getOptionHits,
    getTaskByKey,
    isCaptureComplete,
    markTaskFailure,
    markTaskSuccess,
    recordTaskSuccessByKey,
    selectNextChoiceTask,
} from './ag.plan';
import { AGMongoStore } from './ag.mongo';
import {
    AGCaptureLimits,
    AGCaptureState,
    AGCaptureTask,
    AGCompletedRound,
    AGGameConfig,
} from './ag.types';
import { captureAGRound, selectFreeChoiceOption } from './ag.round';

export interface AGSchedulerOptions {
    validationSamples?: number;
    store: AGMongoStore;
    limits: AGCaptureLimits;
    concurrentGames: number;
    workersPerGame: number;
    retryAttempts: number;
    retryDelayMs: number;
    spinDelayMs: number;
    logInterval: number;
    sessionReadyDelayMs: number;
    sessionRecycleDelayMs: number;
    workerStartJitterMs: number;
    shouldClear: boolean;
    maxRoundsPerGame: number;
    ownerId: string;
    gameLeaseMs: number;
    gameLeaseRenewMs: number;
    shutdownSignal?: AbortSignal;
}

interface CaptureAttemptResult {
    session: RoxorCometDSession | null;
    round: AGCompletedRound | null;
    reservedChoice: AGCaptureTask | null;
    error?: Error;
}

function sleep(ms: number, shutdownSignal?: AbortSignal): Promise<void> {
    if (ms <= 0 || shutdownSignal?.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);

        function done() {
            clearTimeout(timer);
            shutdownSignal?.removeEventListener('abort', done);
            resolve();
        }

        shutdownSignal?.addEventListener('abort', done, { once: true });
    });
}

export function isDeterministicCaptureError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unsupported AG nextAction|MalformedRequest|RuntimeError|missing supported next action|AG integrity:|no selectable option|exceeded \d+ follow-up steps|protocol negotiation failed|协议协商失败/i.test(message);
}

// 工作流在此退出码上立即失败，禁止换进程后用已有 staging 配额掩盖协议错误。
export const DETERMINISTIC_CAPTURE_EXIT_CODE = 78;

export function throwIfSchedulerFailed(failures: Error[]): void {
    if (failures.length === 0) {
        return;
    }
    throw new Error(
        `${failures.length} game capture failed: ${failures.map((error) => error.message).join('; ')}`,
    );
}

function getDbName(game: AGGameConfig): string {
    return game.dbName || game.serviceDir || 'db_ag';
}

function formatState(state: AGCaptureState): string {
    const parts = state.tasks.map((task) => {
        if (task.kind !== 'choice') {
            return `${task.key}=${task.current}/${task.target}`;
        }
        return `choice${task.optionIndex}=${task.current}/${task.target}`;
    });
    return parts.join(' ');
}

export function getCaptureSampleGroups(round: AGCompletedRound, state: AGCaptureState): string[] {
    const groups: string[] = [];
    const featureTask = getTaskByKey(state, 'feature');
    if (round.isFeature && featureTask && featureTask.current < featureTask.target) groups.push('feature');
    const events = new Set((round.data.roundEvents || []).map((event:string)=>event.toLowerCase()));
    for (const task of state.tasks) {
        if (task.key.startsWith('event:') && events.has(task.key.slice(6)) && task.current < task.target) groups.push(task.key);
    }
    const baseTask = getTaskByKey(state, 'base');
    if (baseTask && baseTask.current + baseTask.inFlight < baseTask.target) {
        groups.push('base');
    }

    if (round.optionIndex > 0) {
        const choiceTask = getTaskByKey(state, `choice:${round.optionIndex}`);
        if (choiceTask && choiceTask.current < choiceTask.target) {
            groups.push(`choice:${round.optionIndex}`);
        }
    }
    return groups;
}

class AGGameRunner {
    private state!: AGCaptureState;
    private playedRounds = 0;
    private readonly liveSessions = new Set<RoxorCometDSession>();
    private leaseTimer: NodeJS.Timeout | null = null;
    private leaseLost = false;
    private leaseAcquired = false;
    private readonly workerErrors: Error[] = [];
    private fatalError: Error | null = null;

    constructor(
        private readonly game: AGGameConfig,
        private readonly options: AGSchedulerOptions,
    ) {}

    private get dbName(): string {
        return getDbName(this.game);
    }

    private reachedRoundLimit(): boolean {
        return this.options.maxRoundsPerGame > 0 && this.playedRounds >= this.options.maxRoundsPerGame;
    }

    private isShuttingDown(): boolean {
        return this.options.shutdownSignal?.aborted === true;
    }

    private shouldStop(): boolean {
        return this.fatalError !== null || this.isShuttingDown() || this.leaseLost || isCaptureComplete(this.state) || this.reachedRoundLimit();
    }

    private async acquireLease(): Promise<boolean> {
        const acquired = await this.options.store.tryAcquireGameLease(
            this.dbName,
            this.game.gameId,
            this.options.ownerId,
            this.options.gameLeaseMs,
        );
        this.leaseAcquired = acquired;
        if (!acquired) {
            console.log(`[lock] skip ${this.game.gameId} db=${this.dbName} locked by another capture process`);
        }
        return acquired;
    }

    private startLeaseRenewal() {
        const interval = Math.max(1000, this.options.gameLeaseRenewMs);
        this.leaseTimer = setInterval(() => {
            this.options.store
                .renewGameLease(this.dbName, this.options.ownerId, this.options.gameLeaseMs)
                .then((renewed) => {
                    if (!renewed) {
                        this.leaseLost = true;
                        console.warn(`[lock] lost ${this.game.gameId} db=${this.dbName}, stopping workers`);
                    }
                })
                .catch((error) => {
                    this.leaseLost = true;
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[lock] renew failed ${this.game.gameId} db=${this.dbName}: ${message}`);
                });
        }, interval);
        this.leaseTimer.unref?.();
    }

    private stopLeaseRenewal() {
        if (!this.leaseTimer) {
            return;
        }
        clearInterval(this.leaseTimer);
        this.leaseTimer = null;
    }

    private async releaseLease() {
        this.stopLeaseRenewal();
        if (!this.leaseAcquired) {
            return;
        }
        try {
            await this.options.store.releaseGameLease(this.dbName, this.options.ownerId);
        } finally {
            this.leaseAcquired = false;
        }
    }

    private async prepare(): Promise<void> {
        if (this.options.shouldClear) {
            await this.options.store.clearGame(this.dbName);
            console.log(`[game] cleared ${this.game.gameId} db=${this.dbName}`);
        }

        const counts = await this.options.store.getCounts(this.dbName);
        const limits = { ...this.options.limits };
        let expectedEvents: string[] = [];
        if (this.options.validationSamples) {
            const requirements = await this.options.store.getValidationRequirements(this.dbName);
            counts.optionCount = Math.max(counts.optionCount, requirements.optionCount);
            limits.featureTarget = requirements.hasFeature ? this.options.validationSamples : 0;
            expectedEvents = requirements.events;
        }
        this.state = buildCaptureState(counts, limits);
        for (const event of expectedEvents) {
            const current = counts.events?.[event] || 0;
            const target = 1; // 流程验收只需覆盖特殊事件；玩家选项仍各采 validationSamples 条。
            this.state.tasks.push({key:'event:'+event,kind:'feature',optionIndex:0,target,current,
                missing:Math.max(target-current,0),inFlight:0});
        }
        this.state.totalTarget = this.state.tasks.reduce((n, task)=>n+task.target,0);
        this.state.totalCurrent = this.state.tasks.reduce((n, task)=>n+task.current,0);
        console.log(`[game] ready ${this.game.gameId} db=${this.dbName} ${formatState(this.state)}`);
    }

    private async openSession(): Promise<RoxorCometDSession> {
        const session = new RoxorCometDSession(this.game);
        await session.connect();
        this.liveSessions.add(session);
        const handshake = session.getHandshakeData();
        if (handshake) {
            await this.options.store.saveHandshake(this.dbName, handshake);
        }
        if (this.options.sessionReadyDelayMs > 0) {
            await sleep(this.options.sessionReadyDelayMs, this.options.shutdownSignal);
        }
        return session;
    }

    private async resetSession(session: RoxorCometDSession | null): Promise<null> {
        if (!session) {
            return null;
        }
        try {
            session.close();
        } catch {
            // ignore close errors
        }
        this.liveSessions.delete(session);
        if (this.options.sessionRecycleDelayMs > 0) {
            await sleep(this.options.sessionRecycleDelayMs, this.options.shutdownSignal);
        }
        return null;
    }

    private async ensureSession(session: RoxorCometDSession | null): Promise<RoxorCometDSession> {
        return session || this.openSession();
    }

    private chooseAndReserveOption(pickOptions: Array<{ pickIndex: number | string }>): {
        option: { pickIndex: number | string } | null;
        task: AGCaptureTask | null;
    } {
        ensureChoiceTasks(this.state, pickOptions.length, this.options.limits.freeChoicePerOption);
        const optionIndexes = pickOptions
            .map((option) => Number(option.pickIndex))
            .filter((value) => Number.isFinite(value) && value > 0);
        const task = selectNextChoiceTask(this.state, optionIndexes);
        if (task) {
            return {
                task,
                option: pickOptions.find((option) => Number(option.pickIndex) === task.optionIndex) || null,
            };
        }

        return {
            task: null,
            option: selectFreeChoiceOption(pickOptions, getOptionHits(this.state, true)),
        };
    }

    private async captureOnce(
        workerId: number,
        session: RoxorCometDSession | null,
    ): Promise<CaptureAttemptResult> {
        let activeSession = session;
        let reservedChoice: AGCaptureTask | null = null;

        for (let attempt = 0; attempt <= this.options.retryAttempts; attempt += 1) {
            if (this.fatalError) {
                return { session: activeSession, round: null, reservedChoice: null, error: this.fatalError };
            }
            try {
                activeSession = await this.ensureSession(activeSession);
                if (this.fatalError) {
                    return { session: activeSession, round: null, reservedChoice: null, error: this.fatalError };
                }
                reservedChoice = null;
                const round = await captureAGRound(activeSession, {
                    chooseOption: (pickOptions) => {
                        const picked = this.chooseAndReserveOption(pickOptions);
                        reservedChoice = picked.task;
                        return picked.option;
                    },
                });
                this.playedRounds += 1;
                return { session: activeSession, round, reservedChoice };
            } catch (error) {
                if (reservedChoice) {
                    markTaskFailure(this.state, reservedChoice);
                    reservedChoice = null;
                }
                const normalized = error instanceof Error ? error : new Error(String(error));
                // 必须先通知所有线程，再等待 session 清理；否则迟到回合会继续写入共享配额。
                if (isDeterministicCaptureError(normalized)) {
                    this.fatalError ||= normalized;
                }
                activeSession = await this.resetSession(activeSession);
                if (this.fatalError) {
                    return { session: activeSession, round: null, reservedChoice: null, error: this.fatalError };
                }
                if (this.isShuttingDown()) {
                    return { session: activeSession, round: null, reservedChoice: null, error: new Error('shutdown requested') };
                }
                if (attempt < this.options.retryAttempts) {
                    console.warn(
                        `[retry] ${this.game.gameId} worker=${workerId} retry=${attempt + 1}/${this.options.retryAttempts} reason=${normalized.message}`,
                    );
                    await sleep(this.options.retryDelayMs * Math.pow(2, attempt), this.options.shutdownSignal);
                    continue;
                }
                return { session: activeSession, round: null, reservedChoice: null, error: normalized };
            }
        }

        return { session: activeSession, round: null, reservedChoice: null, error: new Error('capture failed') };
    }

    private async storeRound(round: AGCompletedRound, reservedChoice: AGCaptureTask | null): Promise<boolean> {
        const sampleGroups = getCaptureSampleGroups(round, this.state);
        if (sampleGroups.length === 0) {
            if (reservedChoice) {
                markTaskFailure(this.state, reservedChoice);
            }
            return false;
        }

        round.data.captureSampleGroups = sampleGroups;
        await this.options.store.insertRound(this.dbName, round, this.game.rtpBuckets);

        if (sampleGroups.includes('base')) {
            recordTaskSuccessByKey(this.state, 'base');
        }
        if (sampleGroups.includes('feature')) recordTaskSuccessByKey(this.state, 'feature');
        for (const key of sampleGroups.filter(key=>key.startsWith('event:'))) recordTaskSuccessByKey(this.state,key);
        const choiceKey = round.optionIndex > 0 ? `choice:${round.optionIndex}` : '';
        if (choiceKey && sampleGroups.includes(choiceKey)) {
            if (reservedChoice) {
                markTaskSuccess(this.state, reservedChoice);
            } else {
                recordTaskSuccessByKey(this.state, choiceKey);
            }
        } else if (reservedChoice) {
            markTaskFailure(this.state, reservedChoice);
        }
        return true;
    }

    private logProgress(workerId: number, stored: boolean) {
        if (!stored) {
            return;
        }
        if (this.options.logInterval <= 0 || this.state.totalCurrent % this.options.logInterval !== 0) {
            return;
        }
        console.log(`[progress] ${this.game.gameId} worker=${workerId} total=${this.state.totalCurrent}/${this.state.totalTarget} ${formatState(this.state)}`);
    }

    private async workerLoop(workerId: number): Promise<void> {
        let session: RoxorCometDSession | null = null;
        if (this.options.workerStartJitterMs > 0 && workerId > 1) {
            await sleep(this.options.workerStartJitterMs * (workerId - 1), this.options.shutdownSignal);
        }

        try {
            while (!this.shouldStop()) {
                const result = await this.captureOnce(workerId, session);
                session = result.session;
                if (this.fatalError) {
                    if (result.reservedChoice) markTaskFailure(this.state, result.reservedChoice);
                    return;
                }
                if (!result.round) {
                    if (this.isShuttingDown()) {
                        return;
                    }
                    console.warn(`[worker] ${this.game.gameId} worker=${workerId} stopped: ${result.error?.message || 'unknown error'}`);
                    this.workerErrors.push(result.error || new Error('unknown worker error'));
                    return;
                }

                const stored = await this.storeRound(result.round, result.reservedChoice);
                this.logProgress(workerId, stored);

                if (result.round.data?.requiresSessionReset
                    || (Number.isFinite(result.round.balance) && result.round.balance! <= Math.max(result.round.bet, 0))) {
                    session = await this.resetSession(session);
                }
                if (this.options.spinDelayMs > 0) {
                    await sleep(this.options.spinDelayMs, this.options.shutdownSignal);
                }
            }
        } finally {
            await this.resetSession(session);
        }
    }

    private closeLiveSessionsNow() {
        for (const session of Array.from(this.liveSessions)) {
            try {
                session.close();
            } catch {
                // ignore close errors
            }
            this.liveSessions.delete(session);
        }
    }

    private async closeAllSessions() {
        for (const session of Array.from(this.liveSessions)) {
            await this.resetSession(session);
        }
    }

    async run(): Promise<void> {
        if (!this.game.backendId) {
            console.warn(`[skip] ${this.game.gameId} missing backendId`);
            return;
        }

        console.log(`[game] start ${this.game.gameId} (${this.game.name})`);
        const shutdownListener = () => this.closeLiveSessionsNow();
        try {
            if (!(await this.acquireLease())) {
                return;
            }
            this.startLeaseRenewal();
            this.options.shutdownSignal?.addEventListener('abort', shutdownListener, { once: true });
            await this.prepare();
            if (this.shouldStop()) {
                const reason = this.isShuttingDown() ? 'shutdown requested' : 'already complete';
                console.log(`[game] skip ${this.game.gameId} ${reason} ${formatState(this.state)}`);
                return;
            }

            const workerCount = Math.max(1, this.options.workersPerGame);
            await Promise.all(Array.from({ length: workerCount }, (_, index) => this.workerLoop(index + 1)));
            // fatal 前已发出的写入仍可能完成配额，但配额完成不能覆盖协议失败。
            if (this.fatalError) throw this.fatalError;
            const suffix = this.reachedRoundLimit() ? ' round-limit' : '';
            if (isCaptureComplete(this.state)) {
                console.log(`[game] done ${this.game.gameId} ${formatState(this.state)}`);
            } else if (this.workerErrors.length > 0) {
                console.warn(`[game] incomplete ${this.game.gameId} worker-errors=${this.workerErrors.length} ${formatState(this.state)}`);
                throw new Error(
                    `AG capture incomplete: ${formatState(this.state)}; ${this.workerErrors.map((error) => error.message).join('; ')}`,
                );
            } else {
                console.log(`[game] stopped ${this.game.gameId}${suffix} ${formatState(this.state)}`);
                throw new Error(`AG capture stopped before quota: ${formatState(this.state)}`);
            }
        } finally {
            this.options.shutdownSignal?.removeEventListener('abort', shutdownListener);
            try {
                await this.closeAllSessions();
                await this.releaseLease();
            } finally {
                // 清理失败或其他线程的写入异常也不能把已知 fatal 降级为可重试错误。
                if (this.fatalError) throw this.fatalError;
            }
        }
    }
}

export async function runAGScheduler(games: AGGameConfig[], options: AGSchedulerOptions): Promise<void> {
    if (!games.length) {
        console.log('[scheduler] no AG games to capture');
        return;
    }

    let nextIndex = 0;
    let shutdownLogged = false;
    const failures: Error[] = [];
    const slots = Math.max(1, Math.min(options.concurrentGames, games.length));
    await Promise.all(Array.from({ length: slots }, async (_, slotIndex) => {
        for (;;) {
            if (options.shutdownSignal?.aborted) {
                if (!shutdownLogged) {
                    shutdownLogged = true;
                    console.log('[scheduler] shutdown requested, no new AG games will be started');
                }
                return;
            }

            const index = nextIndex;
            nextIndex += 1;
            if (index >= games.length) {
                return;
            }

            const game = games[index];
            console.log(`[scheduler] slot=${slotIndex + 1} game=${game.gameId}`);
            try {
                await new AGGameRunner(game, options).run();
            } catch (error) {
                const normalized = error instanceof Error ? error : new Error(String(error));
                failures.push(normalized);
                console.error(`[scheduler] game ${game.gameId} failed: ${normalized.message}`);
            }
        }
    }));
    throwIfSchedulerFailed(failures);
}
