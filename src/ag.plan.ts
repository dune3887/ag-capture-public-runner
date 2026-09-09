import {
    AGCaptureLimits,
    AGCaptureState,
    AGCaptureTask,
    AGMongoCounts,
} from './ag.types';

function completionRate(task: AGCaptureTask): number {
    if (task.target <= 0) {
        return 1;
    }
    return Math.min((task.current + task.inFlight) / task.target, 1);
}

function refreshTask(task: AGCaptureTask) {
    task.missing = Math.max(task.target - task.current, 0);
}

function refreshTotals(state: AGCaptureState) {
    state.totalTarget = state.tasks.reduce((sum, task) => sum + task.target, 0);
    state.totalMissing = state.tasks.reduce((sum, task) => sum + Math.max(task.target - task.current, 0), 0);
}

function compareTasks(left: AGCaptureTask, right: AGCaptureTask): number {
    const leftRate = completionRate(left);
    const rightRate = completionRate(right);
    if (leftRate !== rightRate) {
        return leftRate - rightRate;
    }

    if (left.current !== right.current) {
        return left.current - right.current;
    }

    if (left.target !== right.target) {
        return left.target - right.target;
    }

    if (left.kind !== right.kind) {
        return left.kind === 'base' ? -1 : 1;
    }

    return left.optionIndex - right.optionIndex;
}

export function applyGameShard<T>(games: T[], shardIndex: number, shardTotal: number): T[] {
    if (!Number.isFinite(shardTotal) || shardTotal <= 1) {
        return games;
    }
    if (!Number.isFinite(shardIndex) || shardIndex < 1 || shardIndex > shardTotal) {
        throw new Error(`invalid shard index ${shardIndex}/${shardTotal}`);
    }

    return games.filter((_, index) => index % shardTotal === shardIndex - 1);
}

export function buildCaptureState(counts: AGMongoCounts, limits: AGCaptureLimits): AGCaptureState {
    const tasks: AGCaptureTask[] = [];
    const spinTarget = Math.max(0, limits.spinLimit);
    const choiceTarget = Math.max(0, limits.freeChoicePerOption);
    if ((limits.featureTarget || 0) > 0) {
        const current = counts.feature || 0;
        tasks.push({key:'feature',kind:'feature',optionIndex:0,target:limits.featureTarget!,current,
            missing:Math.max(limits.featureTarget! - current, 0),inFlight:0});
    }

    if (spinTarget > 0) {
        tasks.push({
            key: 'base',
            kind: 'base',
            optionIndex: 0,
            target: spinTarget,
            current: Math.max(0, counts.base || 0),
            missing: Math.max(spinTarget - (counts.base || 0), 0),
            inFlight: 0,
        });
    }

    if (choiceTarget > 0) {
        for (let optionIndex = 1; optionIndex <= Math.max(0, counts.optionCount || 0); optionIndex += 1) {
            const current = Math.max(0, counts.freeChoiceOptions[optionIndex] || 0);
            tasks.push({
                key: `choice:${optionIndex}`,
                kind: 'choice',
                optionIndex,
                target: choiceTarget,
                current,
                missing: Math.max(choiceTarget - current, 0),
                inFlight: 0,
            });
        }
    }

    const state: AGCaptureState = {
        tasks,
        optionCount: Math.max(0, counts.optionCount || 0),
        // 一条选择回合可以同时计入整体样本和选项样本；这里统计配额进度，而不是物理文档数。
        totalCurrent: tasks.reduce((sum, task) => sum + task.current, 0),
        totalTarget: 0,
        totalMissing: 0,
    };
    refreshTotals(state);
    return state;
}

export function ensureChoiceTasks(
    state: AGCaptureState,
    optionCount: number,
    freeChoicePerOption: number,
) {
    const target = Math.max(0, freeChoicePerOption);
    if (target <= 0 || optionCount <= state.optionCount) {
        return;
    }

    for (let optionIndex = state.optionCount + 1; optionIndex <= optionCount; optionIndex += 1) {
        state.tasks.push({
            key: `choice:${optionIndex}`,
            kind: 'choice',
            optionIndex,
            target,
            current: 0,
            missing: target,
            inFlight: 0,
        });
    }

    state.optionCount = optionCount;
    refreshTotals(state);
}

export function selectNextTask(
    state: AGCaptureState,
    predicate: (task: AGCaptureTask) => boolean = () => true,
): AGCaptureTask | null {
    const candidates = state.tasks.filter(
        (task) => predicate(task) && task.current + task.inFlight < task.target,
    );
    if (!candidates.length) {
        return null;
    }

    candidates.sort(compareTasks);
    const task = candidates[0];
    task.inFlight += 1;
    return task;
}

export function selectNextChoiceTask(
    state: AGCaptureState,
    optionIndexes: number[],
): AGCaptureTask | null {
    const allowed = new Set(optionIndexes.filter((value) => Number.isFinite(value) && value > 0));
    return selectNextTask(state, (task) => task.kind === 'choice' && allowed.has(task.optionIndex));
}

export function markTaskSuccess(state: AGCaptureState, task: AGCaptureTask): void {
    task.inFlight = Math.max(0, task.inFlight - 1);
    task.current += 1;
    refreshTask(task);
    state.totalCurrent += 1;
    refreshTotals(state);
}

export function markTaskFailure(state: AGCaptureState, task: AGCaptureTask): void {
    task.inFlight = Math.max(0, task.inFlight - 1);
    refreshTask(task);
    refreshTotals(state);
}

export function getTaskByKey(state: AGCaptureState, key: string): AGCaptureTask | null {
    return state.tasks.find((task) => task.key === key) || null;
}

export function recordTaskSuccessByKey(state: AGCaptureState, key: string): AGCaptureTask | null {
    const task = getTaskByKey(state, key);
    if (!task || task.current >= task.target) {
        return null;
    }

    task.current += 1;
    refreshTask(task);
    state.totalCurrent += 1;
    refreshTotals(state);
    return task;
}

export function isCaptureComplete(state: AGCaptureState): boolean {
    return state.tasks.every((task) => task.current >= task.target);
}

export function getOptionHits(state: AGCaptureState, includeInflight = false): Record<number, number> {
    const hits: Record<number, number> = {};
    for (const task of state.tasks) {
        if (task.kind !== 'choice') {
            continue;
        }
        hits[task.optionIndex] = task.current + (includeInflight ? task.inFlight : 0);
    }
    return hits;
}
