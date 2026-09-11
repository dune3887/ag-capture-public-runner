import { AGCompletedRound, AGRoundStep } from './ag.types';

// 仅精确识别供应方拒绝响应；不依赖错误文本猜测请求阶段。
export class AGProviderResponseError extends Error {
    constructor(readonly event: string, readonly reason: 'MalformedRequest' | 'error-only') {
        super('AG integrity: provider response ' + JSON.stringify({event, reason}));
        this.name = 'AGProviderResponseError';
    }
}

// 供应方只返回 error 时，整局作废；由调度器关闭会话后限次重建，禁止重放功能请求。
export class AGDiscardedRoundError extends Error {
    constructor(readonly event: string) {
        super('整局丢弃并重建会话: ' + event + ' 返回 error-only');
        this.name = 'AGDiscardedRoundError';
    }
}

export class AGInitialSpinResponseError extends Error {
    constructor(readonly reason: 'error-only') {
        super('initial Spin discarded; reset session: ' + reason);
        this.name = 'AGInitialSpinResponseError';
    }
}

export class AGInitialSpinRuntimeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AGInitialSpinRuntimeError';
    }
}

export function isInitialSpinRuntimeError(error: unknown): error is AGInitialSpinRuntimeError {
    return error instanceof AGInitialSpinRuntimeError;
}

export interface AGPickOption {
    pickIndex: number | string;
    requestPickIndex?: number | string;
    [key: string]: any;
}

export interface AGPickProtocol {
    event: string;
    kind: 'choice' | 'reveal';
    revealedIndexes?: number[];
    // 奖池位置由服务端映射到玩家点击，不把采集盘面位置变成回放硬约束。
    remapReveal?: boolean;
    options: AGPickOption[];
}

export interface AGSessionLike {
    callGameData(event: string, parameters: Record<string, any> | null): Promise<Record<string, any>>;
    getSpinParams(): Record<string, any>;
    getFollowUpParams?(): Record<string, any>;
    getPickParams(pickIndex: number | string): Record<string, any>;
    getPickEvent?(): string;
    getPickProtocol?(action: string, response: Record<string, any>, revealedIndexes: readonly number[]): AGPickProtocol | undefined;
    getSequentialPickIndex?(index: number, trigger: Record<string, any>): number;
    getLegacyPickCompletionRequest?(mode: string): {event: string; parameters: Record<string, any>} | undefined;
    getFallbackBet(): number;
    getBalance?(): number;
    getLastGameRequest?(): { event: string; parameters: Record<string, any> | null } | undefined;
    getInitialRoundRequest?(): { event: string; parameters: Record<string, any> | null };
    getExactFollowUpRequest?(action: string): {event: string; parameters: Record<string, any>} | undefined;
    getActionParams?(action: string, event: string): Record<string, any> | null;
    isRoundTerminalAction?(action: string): boolean;
}

export interface CaptureAGRoundOptions {
    maxSteps?: number;
    // 官方免费玩法（如 Phoenix Gold 1.0.7 的 FreeSpinsInfo 重触发与逐次级联）可让一局
    // 合法地超过基础步数上限；进入免费玩法阶段后改用这个更高的、仍有界的上限。
    featureMaxSteps?: number;
    // 免费玩法阶段允许的「连续无进展」步数上限：用于把合法长局与原地打转的循环区分开，
    // 判定依据是会推进的计数（免费转计数/累计赢奖/余额/级联结构），不靠动作名重复。
    stallWindow?: number;
    optionHits?: Record<number, number>;
    chooseOption?: (pickOptions: AGPickOption[]) => AGPickOption | null;
}

interface FollowUpCandidate {
    event: string;
    params: Record<string, any> | null;
}

function normalizedAction(action: unknown): string {
    return String(action || '').trim().toUpperCase();
}

export function nextActionOf(data: Record<string, any> | null | undefined): string {
    return normalizedAction(data?.NextActionInfo?.nextAction);
}

export function isPickState(action: unknown): boolean {
    const value = normalizedAction(action);
    return ['PICK', 'PICK_SCREEN', 'SELECTION', 'PICK_SELECTION'].includes(value)
        || value.endsWith('_PICK')
        || value.startsWith('PICK_')
        || value.includes('_PICK_');
}

export function isFreeState(action: unknown): boolean {
    return normalizedAction(action).includes('FREE');
}

// 明确的免费玩法动作白名单：免费转 / 免费级联 / 免费关本身。
// 刻意不用 isFreeState 的 includes('FREE')：PICK_FREE_SPINS 这类「含 FREE 字样的选择态」
// 并不代表进入了免费转循环，用它放宽步数上限会让分片故障被推迟暴露。
export function isFreeFeatureAction(action: unknown): boolean {
    return /(^|_)(FREE_?SPIN|FREE_?CASCADE|FREE_?GAME|FREE_?FEATURE)$/.test(normalizedAction(action));
}

export function isRoundTerminal(action: unknown): boolean {
    const value = normalizedAction(action);
    return value === '' || value === 'SPIN' || value === 'BASE' || value === 'NORMAL';
}

// 免费玩法阶段的进展指纹：官方协议里 FreeSpinsInfo.freeSpinsPlayed / freeSpinsRemaining /
// accumulativeWin 会随每次免费转推进，级联会改变 CascadeInfo 的符号变更条目数。
// 这里只用这些「会推进的计数」判进展，既不看动作名重复，也不输出任何字段值。
export function featureProgressKey(data: Record<string, any> | null | undefined): string | null {
    const info = data?.FreeSpinsInfo;
    if (!info || typeof info !== 'object') {
        return null;
    }
    const numeric = (value: unknown): number | null => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const cascadeChanges = Array.isArray(data?.CascadeInfo?.cascadeSymbolsData?.symbolChangeDatas)
        ? data.CascadeInfo.cascadeSymbolsData.symbolChangeDatas.length
        : null;
    return JSON.stringify([
        numeric(info.freeSpinsPlayed),
        numeric(info.freeSpinsRemaining),
        numeric(info.accumulativeWin),
        numeric(data?.PlayerBalanceInfo?.balance),
        cascadeChanges,
    ]);
}

// 长局诊断只保留动作名、事件名、字段名与计数；绝不写字段值、会话标识或凭据。
export function longRoundDiagnostic(
    steps: Array<{ action?: string; event?: string }>,
    current: Record<string, any> | null | undefined,
): string {
    return JSON.stringify({
        steps: steps.length,
        actions: [...new Set(steps.map((step) => normalizedAction(step.action)))].sort(),
        events: [...new Set(steps.map((step) => String(step.event)))].sort(),
        freeSpinsInfo: Boolean(current?.FreeSpinsInfo),
        cascadeInfo: Boolean(current?.CascadeInfo),
        responseFieldNames: Object.keys(current || {}).sort(),
    });
}

export function selectFreeChoiceOption(
    pickOptions: AGPickOption[],
    hits: Record<number, number>,
): AGPickOption | null {
    let best: { option: AGPickOption; hitCount: number; optionIndex: number } | null = null;
    for (const option of pickOptions) {
        const optionIndex = Number(option.pickIndex);
        if (!Number.isFinite(optionIndex) || optionIndex <= 0) {
            continue;
        }

        const hitCount = hits[optionIndex] || 0;
        if (!best || hitCount < best.hitCount || (hitCount === best.hitCount && optionIndex < best.optionIndex)) {
            best = { option, hitCount, optionIndex };
        }
    }

    return best?.option || null;
}

function resolveFollowUpEvent(action: string): string {
    const value = normalizedAction(action);
    const eventMap: Record<string, string> = {
        WICKED_WINNINGS_FREE_SPIN: 'wickedWinningsFreeSpin',
        WICKED_WINNINGS_RESPIN: 'wickedWinningsRespin',
        CASHMAN_FREE_SPIN: 'cashmanFreeSpin',
        CASHMAN_PICK: 'cashmanPick',
        CASHMAN_RESPIN: 'cashmanRespin',
        MORE_CHILLI_FREE_SPIN: 'moreChilliFreeSpin',
        MORE_CHILLI_CASHMAN_FREE_SPIN: 'moreChilliCashmanFreeSpin',
        MORE_CHILLI_CASHMAN_RESPIN: 'moreChilliCashmanRespin',
        MORE_CHILLI_CASHMAN_PICK: 'moreChilliCashmanPick',
        WICKED_WINNINGS_CASHMAN_FREE_SPIN: 'wickedWinningsCashmanFreespin',
        WICKED_WINNINGS_MORE_CHILLI_FREE_SPIN: 'wickedWinningsMoreChilliFreeSpin',
        WICKED_WINNINGS_MORE_CHILLI_RESPIN: 'wickedWinningsMoreChilliRespin',
        WICKED_WINNINGS_MORE_CHILLI_CASHMAN_FREE_SPIN: 'wickedWinningsMoreChilliCashmanFreeSpin',
        WICKED_WINNINGS_MORE_CHILLI_CASHMAN_RESPIN: 'wickedWinningsMoreChilliCashmanRespin',
        WICKED_WINNINGS_MORE_CHILLI_CASHMAN_PICK: 'wickedWinningsMoreChilliCashmanPick',
        FREE_SPIN: 'freeSpin',
        FREE_FEATURE: 'freefeature',
        FREE_PICK: 'freepick',
        PICK_FREE_SPINS: 'pickFreeSpins',
        PICK_GOLD_COIN: 'pickGoldCoins',
        PICK_GOLD_COINS: 'pickGoldCoins',
        MIGHTY_CASH_SPIN: 'mightyCashSpin',
        CASH_COLLECT: 'cashCollect',
        CLOWN_MULTIPLIER_SPIN: 'clownMultiplierSpin',
        BONUS_BOOST_SPIN: 'bonusBoostSpin',
        NEXT_TRAIN: 'nexttrain',
        GOLDEN_FRENZY_SPIN: 'goldenFrenzySpin',
        BONUS_SPIN: 'bonusSpin',
        BONUS: 'BonusSpin',
        BONUS_ENTRY: 'bonusEntry',
        // 已核对的 Secrets of the Queen Classic 1.0.0 官方前端：LOCK_SPIN 状态发送小写 lockspin，
        // 与 Spin/FreeSpin 共用 {coinSize,numberOfCoins} 载荷（standard 协议默认 follow-up 参数）。
        LOCK_SPIN: 'lockspin',
        // 已核对的 Lucky88 2.0.1 官方前端：DICE_SPIN 状态发送小写 dicespin 且载荷为空 {}
        //（空参数由 ag.client.ts 的 getActionParams dicespin 分支处理）。
        DICE_SPIN: 'dicespin',
        FEATURE: 'feature',
        HAMMER_SPIN: 'hammerSpin',
        HOLD_AND_GOLD_SPIN: 'holdAndGoldSpin',
        RIBBON_WHEEL_SPIN: 'RibbonWheelSpin',
        WHEEL_SPIN: 'wheelSpin',
        // 官方 Wild Leprecoins Double Luck 客户端的两个自动转盘事件（均为小写）。
        GREEN_WHEEL_SPIN: 'greenwheelspin',
        GOLDEN_WHEEL_SPIN: 'goldenwheelspin',
        CLOWN_BALL_DROP: 'clownBallDrop',
        NEXT_PICK_ROUND: 'RoundPickEvent',
    };
    if (eventMap[value]) {
        return eventMap[value];
    }
    if (value === 'RESPIN') {
        return 'respin';
    }
    if (value === 'SPIN') {
        return 'Spin';
    }
    if (value === 'WAGER') {
        return 'wager';
    }
    if (value === 'PLAY') {
        return 'play';
    }
    if (value === 'JACKPOT_PLAY' || value === 'JACKPOTPLAY') {
        return 'jackpotplay';
    }
    if (value === 'CASCADE' || value === 'CASCADE_SPIN') {
        return 'Cascade';
    }
    if (value === 'FREE_CASCADE' || value === 'FREE_SPIN_CASCADE' || value === 'FREESPIN_CASCADE') {
        return 'FreeCascade';
    }
    if (value === 'REWARD_SPIN') {
        return 'rewardSpin';
    }
    if (isFreeState(value)) {
        return 'FreeSpin';
    }
    if (isPickState(value)) {
        return 'pick';
    }
    throw new Error(`unsupported AG nextAction: ${value || '(empty)'}`);
}

function getFollowUpParams(session: AGSessionLike, action: string, event: string): Record<string, any> | null {
    if (typeof session.getActionParams === 'function') {
        return session.getActionParams(action, event);
    }
    if (typeof session.getFollowUpParams === 'function') {
        return session.getFollowUpParams();
    }

    const params = { ...session.getSpinParams() };
    delete params.replayActions;
    return params;
}

function isProtocolRetryable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /MalformedRequest|RuntimeError/i.test(message);
}

function uniqueCandidates(candidates: FollowUpCandidate[]): FollowUpCandidate[] {
    const seen = new Set<string>();
    const result: FollowUpCandidate[] = [];
    for (const candidate of candidates) {
        const key = `${candidate.event}:${JSON.stringify(candidate.params || {})}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(candidate);
    }
    return result;
}

function followUpEventCandidates(action: string, primary: string): string[] {
    const value = normalizedAction(action);
    const candidates = [primary];

    if (value === 'FREE_CASCADE' || value === 'FREE_SPIN_CASCADE' || value === 'FREESPIN_CASCADE') {
        candidates.push('freecascade', 'FreeCascade', 'Cascade');
    } else if (isFreeState(value)) {
        candidates.push('freespin', 'FreeSpin', 'FreeSpins', 'Spin');
        if (value === 'FREE_SPIN') {
            // Hot Off the 7s 的官方前端把 FREE_SPIN 状态发送为小写 respin。
            candidates.push('respin', 'Respin');
        }
    } else if (value.includes('RESPIN')) {
        candidates.push('respin', 'Respin');
    } else if (value === 'CASCADE' || value === 'CASCADE_SPIN') {
        candidates.push('Cascade');
    } else if (primary === 'Spin') {
        candidates.push('Spin');
    }

    return [...new Set(candidates)];
}

function pickEventCandidates(session: AGSessionLike, action: string, primary: string): string[] {
    const sessionEvent = typeof session.getPickEvent === 'function' ? session.getPickEvent() : '';
    const resolved = sessionEvent || (primary === 'Spin' ? 'pick' : primary);
    return [...new Set([resolved, 'pick', 'Pick'])];
}

function pickRequestCandidates(
    session: AGSessionLike,
    action: string,
    primary: string,
    pickIndex: number | string,
): FollowUpCandidate[] {
    const events = pickEventCandidates(session, action, primary);
    const indexes: Array<number | string> = [pickIndex];
    const numericIndex = Number(pickIndex);
    if (Number.isInteger(numericIndex) && numericIndex > 0) {
        indexes.push(numericIndex - 1);
    }

    const candidates: FollowUpCandidate[] = [];
    for (const event of events) {
        for (const index of indexes) {
            candidates.push(
                { event, params: session.getPickParams(index) },
                { event, params: { pickIndex: index } },
                { event, params: { pickIndex: String(index) } },
            );
        }
        candidates.push(
            { event, params: getFollowUpParams(session, action, event) },
            { event, params: {} },
            { event, params: null },
        );
    }
    return uniqueCandidates(candidates);
}

async function callFirstSuccessful(
    session: AGSessionLike,
    candidates: FollowUpCandidate[],
): Promise<AGRoundStep> {
    const errors: string[] = [];
    const unique = uniqueCandidates(candidates);

    for (let index = 0; index < unique.length; index += 1) {
        const candidate = unique[index];
        try {
            const data = await session.callGameData(candidate.event, candidate.params);
            const sent = session.getLastGameRequest?.();
            return {
                event: sent?.event || candidate.event,
                parameters: structuredClone(sent ? sent.parameters : candidate.params),
                data,
            };
        } catch (error) {
            if (error instanceof AGProviderResponseError && error.reason === 'error-only') {
                throw new AGDiscardedRoundError(error.event);
            }
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${candidate.event}: ${message}`);
            if (index === unique.length - 1 || !isProtocolRetryable(error)) {
                throw new Error(errors.join(' | '));
            }
        }
    }

    throw new Error('no AG follow-up candidates');
}

function toNumber(value: unknown, fallback = 0): number {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

function resolveBet(data: Record<string, any>, fallbackBet: number): number {
    const wager = toNumber(data?.PlayerBalanceInfo?.wager);
    return wager > 0 ? wager : fallbackBet;
}

interface WinResolution {
    win: number;
    protocolWin: number;
    balanceDerivedWin: number | null;
    method: 'balance-delta' | 'protocol';
}

function responseWin(data: Record<string, any>): number {
    const resultAmount = Number(data?.PlayerBalanceInfo?.resultAmount);
    const grossWin = Number(data?.GameSlotResultInfo?.grossWin);
    if (Number.isFinite(resultAmount) && resultAmount > 0) {
        return resultAmount;
    }
    if (Number.isFinite(grossWin) && grossWin > 0) {
        return grossWin;
    }
    return Number.isFinite(resultAmount) ? resultAmount : (Number.isFinite(grossWin) ? grossWin : 0);
}

function resolveProtocolWin(trigger: Record<string, any>, steps: AGRoundStep[], isFeature: boolean): number {
    if (trigger?.PickGameInfo?.requestMode === 'legacy-stateful-spin-pick') {
        const coinSize = toNumber(trigger?.GameWageringInfo?.currentCoinSize);
        const bonusMultiplier = Math.max(toNumber(trigger?.PickGameInfo?.bonusMultiplier, 1), 1);
        const pickedCoins = steps.reduce((total, step) => {
            const pickItemEvent = step.data?.XmlEvents?.PickItemEvent;
            const pickEvents = Array.isArray(pickItemEvent) ? pickItemEvent : [pickItemEvent];
            return total + pickEvents.reduce((eventTotal, pickEvent) => {
                const rawItems = pickEvent?.PickItem;
                const items = Array.isArray(rawItems) ? rawItems : [rawItems];
                return eventTotal + items.reduce((itemTotal, item) => (
                    String(item?.type || '').toUpperCase() === 'WIN'
                        ? itemTotal + toNumber(item?.value)
                        : itemTotal
                ), 0);
            }, 0);
        }, 0);
        return Number((pickedCoins * bonusMultiplier * coinSize).toFixed(12));
    }

    if (isFeature) {
        const freeStep = [...steps].reverse().find((step) => step.data?.FreeSpinsInfo);
        if (freeStep) {
            return toNumber(freeStep.data.FreeSpinsInfo.accumulativeWin);
        }
    }

    // JSON 与 XML 的级联响应都可能把每一步奖励分别放在 resultAmount 中。
    // 旧逻辑只累计 XML，JSON 级联最后一步为 0 时会把整局错误记成 0。
    const hasCascade = steps.some((step) => normalizedAction(step.event).includes('CASCADE'));
    if (hasCascade) {
        return [trigger, ...steps.map((step) => step.data)]
            .reduce((total, data) => total + responseWin(data), 0);
    }

    // jackpotplay 等终止步骤经常返回 0；取最后一个明确的正奖励，避免覆盖 play 的真实奖励。
    const responses = [trigger, ...steps.map((step) => step.data)];
    const lastPositive = [...responses].reverse().find((data) => responseWin(data) > 0);
    return lastPositive ? responseWin(lastPositive) : responseWin(responses[responses.length - 1] || trigger);
}

export function hasExplicitXmlBalance(data: Record<string, any>): boolean {
    const events = data?.XmlEvents;
    if (!events || typeof events !== 'object') {
        return true;
    }

    const balanceEvents = [
        events.GameOverEvent,
        events.PickBonusResultEvent,
        events.PickBonusEvent,
        events.MultiRoundPickBonusEvent,
        events.SetBalanceEvent,
        events.CountUpBalanceEvent,
        events.UpdateBalancePostWagerEvent,
        events.DisplayWinEvent,
    ];
    return balanceEvents.some((event) => {
        const values = Array.isArray(event) ? event : [event];
        return values.some((value) => value && typeof value === 'object'
            && (value.balance !== undefined || value.to !== undefined));
    });
}

function resolveFinalBalance(trigger: Record<string, any>, steps: AGRoundStep[]): number {
    const responses = [trigger, ...steps.map((step) => step.data)].reverse();
    for (const response of responses) {
        const balance = Number(response?.PlayerBalanceInfo?.balance);
        if (!Number.isFinite(balance)) {
            continue;
        }
        // 旧 XML 解析器会把缺失数字字段表示成 0；只有响应中确实带余额事件时才接受该 0。
        if (balance !== 0 || hasExplicitXmlBalance(response)) {
            return balance;
        }
    }
    return Number.NaN;
}

function resolveBalanceDerivedWin(
    trigger: Record<string, any>,
    finalBalance: number,
    bet: number,
): number | null {
    const preWagerBalance = Number(trigger?.PlayerBalanceInfo?.preWagerBalance);
    if (!Number.isFinite(preWagerBalance) || !Number.isFinite(finalBalance) || bet <= 0) {
        return null;
    }

    const derived = finalBalance - preWagerBalance + bet;
    // 浮点误差可能产生极小负数；真实负值说明该响应不具备可比余额口径，回退到协议赢分。
    if (derived < -1e-7) {
        return null;
    }
    return Math.abs(derived) <= 1e-7 ? 0 : Number(derived.toFixed(12));
}

function resolveWin(
    trigger: Record<string, any>,
    steps: AGRoundStep[],
    isFeature: boolean,
    bet: number,
    finalBalance: number,
    preBalance?: number,
): WinResolution {
    const protocolWin = resolveProtocolWin(trigger, steps, isFeature);
    const balanceDerivedWin = resolveBalanceDerivedWin({ PlayerBalanceInfo: {
        preWagerBalance: trigger.PlayerBalanceInfo?.preWagerBalance ?? preBalance,
    } }, finalBalance, bet);
    if (balanceDerivedWin !== null) {
        return {
            win: balanceDerivedWin,
            protocolWin,
            balanceDerivedWin,
            method: 'balance-delta',
        };
    }

    return {
        win: protocolWin,
        protocolWin,
        balanceDerivedWin: null,
        method: 'protocol',
    };
}

function isFeatureAction(action: string): boolean {
    const value = normalizedAction(action);
    return isFreeState(value)
        || isPickState(value)
        || value.includes('CASCADE')
        || value.includes('RESPIN')
        || value.includes('MIGHTY_CASH')
        || value.includes('GOLD_COIN')
        || value.includes('COLLECT')
        || value.includes('MULTIPLIER')
        || value.includes('BONUS')
        || value.includes('FEATURE')
        || value.includes('NEXT_TRAIN')
        || value.includes('FRENZY')
        || value.includes('HOLD_AND_GOLD')
        || value.includes('HAMMER')
        || value.includes('WHEEL')
        || value.includes('CLOWN');
}

function requiresIndexedPick(action: string): boolean {
    const value = normalizedAction(action);
    // PICK_GOLD_COIN 是自动揭示动作，官方协议为 pickGoldCoins + 投注参数，不带 pickIndex。
    return isPickState(value) && !['PICK_GOLD_COIN', 'PICK_GOLD_COINS', 'NEXT_PICK_ROUND'].includes(value);
}

function protocolContext(action: string, current: Record<string, any>): string {
    const pickInfo = current?.PickGameInfo;
    const pickOptions = Array.isArray(pickInfo?.pickOptions)
        ? pickInfo.pickOptions.map((option: Record<string, any>) => ({
            pickIndex: option?.pickIndex,
            requestPickIndex: option?.requestPickIndex,
            keys: option && typeof option === 'object' ? Object.keys(option).sort() : [],
        }))
        : [];
    const xmlEvents = current?.XmlEvents && typeof current.XmlEvents === 'object'
        ? Object.fromEntries(
            Object.entries(current.XmlEvents)
                .filter(([name]) => /Pick|NextRound|Runtime|PlayMode|Metadata/i.test(name)),
        )
        : null;
    return JSON.stringify({
        action,
        responseKeys: Object.keys(current || {}).sort(),
        protocol: current?.AGProtocolInfo?.format || null,
        nextActionInfo: current?.NextActionInfo || null,
        xmlEvents,
        pickInfo: pickInfo ? {
            keys: Object.keys(pickInfo).sort(),
            requestMode: pickInfo.requestMode,
            requestEvent: pickInfo.requestEvent,
            optionCount: pickInfo.optionCount,
            picks: pickInfo.picks,
            pickOptions,
        } : null,
    });
}

function isPreloadedPickTerminal(current: Record<string, any>): boolean {
    const pickItemEvent = current?.XmlEvents?.PickItemEvent;
    const firstPickItemEvent = Array.isArray(pickItemEvent) ? pickItemEvent[0] : pickItemEvent;
    const pickItems = firstPickItemEvent?.PickItem;
    const normalizedItems = Array.isArray(pickItems) ? pickItems : [pickItems];
    return String(firstPickItemEvent?.isLast || '').toLowerCase() === 'true'
        && normalizedItems.some((item) => String(item?.type || '').toUpperCase() === 'COLLECT');
}

export async function captureAGRound(
    session: AGSessionLike,
    options: CaptureAGRoundOptions = {},
): Promise<AGCompletedRound> {
    const initial = typeof session.getInitialRoundRequest === 'function'
        ? session.getInitialRoundRequest()
        : { event: 'Spin', parameters: session.getSpinParams() };
    const sessionPreBalance = session.getBalance?.();
    let trigger: Record<string, any>;
    try {
        trigger = await session.callGameData(initial.event, initial.parameters);
    } catch (error) {
        if (/^spin$/i.test(initial.event) && error instanceof AGProviderResponseError
            && error.reason === 'error-only'
            && error.event.toLowerCase() === initial.event.toLowerCase()) {
            throw new AGInitialSpinResponseError(error.reason);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/^spin$/i.test(initial.event) && /RuntimeError/i.test(message)) {
            throw new AGInitialSpinRuntimeError(message);
        }
        throw error;
    }
    const initialRequest = session.getLastGameRequest?.() || initial;
    let bet = resolveBet(trigger, session.getFallbackBet());
    let betSource = Number(trigger.PlayerBalanceInfo?.wager) > 0 ? 'response' : 'request-fallback';
    const preBalance = trigger.PlayerBalanceInfo?.preWagerBalance ?? sessionPreBalance;
    if (trigger.XmlEvents && betSource === 'request-fallback' && session.getBalance) {
        const events = trigger.XmlEvents;
        const post = Number(events.UpdateBalancePostWagerEvent?.balance ?? events.SetBalanceEvent?.balance);
        const actualBet = Number(preBalance) - post;
        if (!Number.isFinite(actualBet) || actualBet <= 0) throw new Error('AG integrity: XML round missing authoritative wager');
        bet = Number(actualBet.toFixed(12));
        betSource = 'balance-delta';
    }
    const steps: AGRoundStep[] = [];
    let optionIndex = 0;
    let optionCount = 0;
    let current = trigger;
    let action = nextActionOf(current);
    let encounteredFeature = isFeatureAction(action);
    let availablePickOptions: AGPickOption[] = [];
    let availablePickOptionsSource: 'explicit' | 'raw' | null = null;
    let sequentialPickIndex = 0;
    let verifiedRevealedIndexes: number[] = [];
    let activeLegacyPickMode = '';
    let requiresSessionReset = false;
    let guard = 0;
    const maxSteps = options.maxSteps ?? 300;
    // 官方免费玩法可以在同一局内多次重触发并按次结算级联，合法长局会超过基础步数上限；
    // 因此基础阶段保留 300 的严格上限，一旦确认进入免费玩法阶段就切换到更高的有界上限，
    // 并配合「连续无进展」判定，避免只用固定 300 步截断合法局，也不放任真正的死循环。
    const featureMaxSteps = Math.max(options.featureMaxSteps ?? 1200, maxSteps);
    // stallWindow 必须不小于基础上限：它是「远超旧上限之后」的兜底，不能变成比 300 更早的主闸门。
    const stallWindow = Math.max(options.stallWindow ?? 400, maxSteps);
    // 起手响应本身可能已经处于免费玩法（官方 nextAction=FREE_SPIN / FREE_CASCADE）。
    // 必须从起手就纳入判定：后续响应若不带 FreeSpinsInfo，否则会被按基础 300 误截断合法长局。
    let freeFeatureSeen = Boolean(trigger?.FreeSpinsInfo) || isFreeFeatureAction(nextActionOf(trigger));
    let lastProgressKey: string | null = null;
    let stalledSteps = 0;
    const negotiatedEvents = new Map<string, string>();

    const isTerminal = (value: string) => typeof session.isRoundTerminalAction === 'function'
        ? session.isRoundTerminalAction(value)
        : isRoundTerminal(value);

    while (!isTerminal(action)) {
        // callFirstSuccessful 的返回体只有 {event, parameters, data}，运行时不含 action；
        // 本步实际请求的动作必须在更新下一动作之前先记下，否则会漏判免费玩法。
        const executedAction = action;
        const stepLimit = freeFeatureSeen ? featureMaxSteps : maxSteps;
        if (guard >= stepLimit) {
            const diagnostic = longRoundDiagnostic(steps, current);
            console.error('[AG-LONG-ROUND] ' + diagnostic);
            throw new Error(`AG round exceeded ${stepLimit} follow-up steps ${diagnostic}`);
        }
        guard += 1;

        const primaryEvent = resolveFollowUpEvent(action);
        const actionKey = normalizedAction(action);
        const preferredEvent = negotiatedEvents.get(actionKey);
        const eventCandidates = followUpEventCandidates(action, primaryEvent);
        if (preferredEvent) {
            eventCandidates.unshift(preferredEvent);
        }
        const exact = session.getExactFollowUpRequest?.(action);
        let candidates: FollowUpCandidate[] = exact
            ? [{event: exact.event, params: exact.parameters}]
            : eventCandidates.map((event) => ({ event, params: getFollowUpParams(session, action, event) }));
        let selectableIndexes: Array<number | string> = [];
        let chosenRequestIndex: number | string | undefined;

        // 普通 Match3 响应可省略历史；仅当前连续揭示阶段保留已成功请求的位置。
        if (action !== 'PICK') verifiedRevealedIndexes = [];
        const pickProtocol = requiresIndexedPick(action) ? session.getPickProtocol?.(action, current, verifiedRevealedIndexes) : undefined;
        if (pickProtocol) {
            // 有官方证据的协议只发送精确请求，不协商其他事件或偷偷改变选项。
            const pickOptions = pickProtocol.options;
            const chosen = pickProtocol.kind === 'choice'
                ? (optionIndex === 0 && options.chooseOption ? options.chooseOption(pickOptions) : selectFreeChoiceOption(pickOptions, options.optionHits || {}))
                : pickOptions[0];
            if (!chosen || !pickOptions.includes(chosen)) throw new Error('AG integrity: no selectable option in verified Pick protocol');
            chosenRequestIndex = chosen.requestPickIndex ?? chosen.pickIndex;
            selectableIndexes = pickProtocol.remapReveal ? [] : pickOptions.map(option => option.requestPickIndex ?? option.pickIndex);
            if (pickProtocol.kind === 'choice') {
                if (optionIndex === 0) optionIndex = Number(chosen.pickIndex);
                optionCount = Math.max(optionCount, pickOptions.length);
            }
            candidates = [{event: pickProtocol.event, params: {pickIndex: String(chosenRequestIndex)}}];
        } else if (requiresIndexedPick(action)) {
            const responseRequestMode = String(current?.PickGameInfo?.requestMode || '');
            if (responseRequestMode === 'legacy-multiround-pick') {
                if (activeLegacyPickMode !== responseRequestMode) {
                    sequentialPickIndex = Math.max(sequentialPickIndex, 1);
                }
                activeLegacyPickMode = responseRequestMode;
            } else if (!activeLegacyPickMode && responseRequestMode) {
                activeLegacyPickMode = responseRequestMode;
            }
            const requestMode = activeLegacyPickMode || responseRequestMode;
            if ([
                'legacy-sequential-pick',
                'legacy-multiround-pick',
                'legacy-preloaded-pick',
                'legacy-stateful-spin-pick',
            ].includes(requestMode)) {
                const requestEvent = String(current?.PickGameInfo?.requestEvent || 'Pick');
                const requestIndex = session.getSequentialPickIndex?.(sequentialPickIndex, trigger) ?? sequentialPickIndex;
                candidates = uniqueCandidates([
                    { event: requestEvent, params: { pickIndex: String(requestIndex) } },
                    ...pickRequestCandidates(
                        session,
                        action,
                        requestEvent,
                        requestIndex,
                    ),
                ]);
                sequentialPickIndex += 1;
            } else {
                const explicitPickOptions = Array.isArray(current?.PickGameInfo?.pickOptions)
                    ? current.PickGameInfo.pickOptions as AGPickOption[]
                    : [];
                const rawPicks = Array.isArray(current?.PickGameInfo?.picks)
                    ? current.PickGameInfo.picks as Array<Record<string, any>>
                    : Array.isArray(current?.PickGameInfo?.pickInfos)
                        ? current.PickGameInfo.pickInfos as Array<Record<string, any>>
                        : [];
                // 一些新版游戏只返回 picks，但不同游戏使用的协议 ID 起点并不相同。
                // 官方前端把 picks 映射为 1-based 选择 ID；进入后续揭示阶段才重新使用 0-based 连续索引。
                // 这里分离逻辑选项序号与协议请求 ID，避免污染选项分布。
                let responsePickOptions = explicitPickOptions.length > 0
                    ? explicitPickOptions
                    : rawPicks.map((pick, index) => ({
                        ...pick,
                        pickIndex: index + 1,
                        requestPickIndex: pick.requestPickIndex
                            ?? pick.pickIndex
                            ?? pick.id
                            ?? index + 1,
                    }));
                // Cashman 的两只手由客户端固定为 0/1，响应不带 PickGameInfo。
                // 每次重新出现该状态都重新提供两只手，不能复用连续揭示索引而递增到 2。
                if (responsePickOptions.length === 0 && normalizedAction(action).endsWith('CASHMAN_PICK')) {
                    responsePickOptions = [{pickIndex:1,requestPickIndex:0},{pickIndex:2,requestPickIndex:1}];
                }
                if (responsePickOptions.length > 0) {
                    availablePickOptions = [...responsePickOptions];
                    availablePickOptionsSource = explicitPickOptions.length > 0 ? 'explicit' : 'raw';
                } else if (!current?.PickGameInfo && availablePickOptionsSource === 'raw') {
                    // raw picks 是一次性的功能选择。响应进入下一层 PICK 后，不得继续复用上一层选项。
                    availablePickOptions = [];
                    availablePickOptionsSource = null;
                }
                const pickOptions = availablePickOptions;
                selectableIndexes = pickOptions.map(option => option.requestPickIndex ?? option.pickIndex);
                if (pickOptions.length > 0) {
                    optionCount = Math.max(
                        optionCount,
                        Number(current?.PickGameInfo?.optionCount || 0),
                        pickOptions.length,
                    );
                    const chosen = optionIndex === 0 && options.chooseOption
                        ? options.chooseOption(pickOptions)
                        : selectFreeChoiceOption(pickOptions, options.optionHits || {});
                    if (!chosen) {
                        throw new Error('AG pick state has no selectable option');
                    }
                    if (optionIndex === 0) {
                        optionIndex = Number(chosen.pickIndex);
                    }
                    const requestPickIndex = chosen.requestPickIndex ?? chosen.pickIndex;
                    chosenRequestIndex = requestPickIndex;
                    availablePickOptions = availablePickOptions.filter((option) => {
                        const optionRequestIndex = option.requestPickIndex ?? option.pickIndex;
                        return String(optionRequestIndex) !== String(requestPickIndex);
                    });
                    candidates = pickRequestCandidates(session, action, primaryEvent, requestPickIndex);
                } else {
                    optionIndex = optionIndex || 1;
                    optionCount = Math.max(optionCount, 1);
                    const requestPickIndex = sequentialPickIndex;
                    sequentialPickIndex += 1;
                    candidates = pickRequestCandidates(session, action, primaryEvent, requestPickIndex);
                }
            }
        }

        let completed: AGRoundStep;
        try {
            completed = await callFirstSuccessful(session, candidates);
        } catch (error) {
            if (error instanceof AGDiscardedRoundError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${message} context=${protocolContext(action, current)}`);
        }
        const { event, data: next } = completed;
        if (chosenRequestIndex !== undefined && String(completed.parameters?.pickIndex) !== String(chosenRequestIndex)) {
            // 协议降级不能偷偷把选项 2 改成选项 1，然后仍按选项 2 计数。
            throw new Error('AG integrity: selected option changed during protocol negotiation');
        }
        if (pickProtocol?.kind === 'reveal') {
            verifiedRevealedIndexes = [...(pickProtocol.revealedIndexes || []), Number(chosenRequestIndex)];
        }
        negotiatedEvents.set(actionKey, event);
        // 保存实际成功的请求，而不是仅记录推测的事件名；后续多阶段选择也保留自己的请求 ID。
        // Ultimate Stars 的 Matchball 会以 PICK 表示自动球员揭示。采集探测请求需要带 0，
        // 但真实客户端没有可选项，也不会发送 pickIndex；不要把探测参数变成回放硬约束。
        const automaticPlayerReveal = requiresIndexedPick(action)
            && !current?.PickGameInfo
            && selectableIndexes.length === 0
            && next?.PlayerRevealEvent;
        steps.push({ ...completed, action, requiresPickIndex: requiresIndexedPick(action)
            && completed.parameters?.pickIndex !== undefined && !automaticPlayerReveal, selectableIndexes });
        current = next;
        action = nextActionOf(current);
        // 进入免费玩法阶段后改用有界长局上限，并用会推进的计数判定是否原地打转。
        if (!freeFeatureSeen && (Boolean(current?.FreeSpinsInfo) || isFreeFeatureAction(action) || isFreeFeatureAction(executedAction))) {
            freeFeatureSeen = true;
        }
        if (freeFeatureSeen) {
            const progressKey = featureProgressKey(current);
            if (progressKey !== null && progressKey === lastProgressKey) {
                stalledSteps += 1;
                if (stalledSteps >= stallWindow) {
                    const diagnostic = longRoundDiagnostic(steps, current);
                    console.error('[AG-LONG-ROUND] ' + diagnostic);
                    throw new Error(`AG round exceeded ${stallWindow} follow-up steps without progress ${diagnostic}`);
                }
            } else {
                stalledSteps = 0;
                if (progressKey !== null) lastProgressKey = progressKey;
            }
        }
        // 官方已返回结算/结束事件时，不能再被 COLLECT 的受限兼容分支标为残局。
        if (!isTerminal(action)
            && ['legacy-preloaded-pick', 'legacy-stateful-spin-pick'].includes(activeLegacyPickMode)
            && isPreloadedPickTerminal(current)) {
            const completionRequest = session.getLegacyPickCompletionRequest?.(activeLegacyPickMode);
            if (completionRequest) {
                if (steps.length >= stepLimit) throw new Error('AG round exceeded completion step limit');
                const completion = await callFirstSuccessful(session, [{event: completionRequest.event, params: completionRequest.parameters}]);
                if (!isTerminal(nextActionOf(completion.data))) throw new Error('AG integrity: legacy pick completion did not terminate');
                // -1 是官方自动结算标记，不是玩家可选择的翻牌位置。
                steps.push({...completion, action, requiresPickIndex: false, selectableIndexes: []});
                current = completion.data;
                action = nextActionOf(current);
            } else {
                action = 'SPIN';
                requiresSessionReset = true;
            }
        }
        encounteredFeature = encounteredFeature || isFeatureAction(action);
    }

    if (!action) {
        // 缺失动作不能证明整局结束。仅记录响应结构，不把会话或用户字段值写入日志。
        const lastStep = steps[steps.length - 1];
        throw new Error('AG integrity: missing nextAction ' + JSON.stringify({
            event: lastStep?.event || initialRequest.event,
            previousAction: lastStep?.action || null,
            stepCount: steps.length,
            responseKeys: Object.keys(current || {}).sort(),
            nextActionType: typeof current?.NextActionInfo?.nextAction,
        }));
    }

    const isFeature = optionIndex > 0 || encounteredFeature;
    let balance = resolveFinalBalance(trigger, steps);
    if (activeLegacyPickMode === 'legacy-stateful-spin-pick' && requiresSessionReset) {
        const protocolWin = resolveProtocolWin(trigger, steps, true);
        const postWagerBalance = toNumber(trigger?.PlayerBalanceInfo?.balance, Number.NaN);
        if (Number.isFinite(postWagerBalance)) {
            balance = Number((postWagerBalance + protocolWin).toFixed(12));
        }
    }
    const winResolution = resolveWin(trigger, steps, isFeature, bet, balance, preBalance);
    const win = winResolution.win;
    const finalBalanceInfo = current?.PlayerBalanceInfo || {};
    const data = {
        ...trigger,
        ...current,
        // 顶层字段是整局结束快照；单独保留首次 Spin 的完整原始响应供服务端播放奖励首屏。
        roundTrigger: structuredClone(trigger),
        roundSchemaVersion: 3,
        roundWin: win,
        roundBetSource: betSource,
        roundPreBalance: Number.isFinite(Number(preBalance)) ? Number(preBalance) : undefined,
        roundTerminalAction: action,
        roundRequest: structuredClone(initialRequest),
        PlayerBalanceInfo: {
            ...trigger?.PlayerBalanceInfo,
            ...finalBalanceInfo,
            wager: toNumber(finalBalanceInfo.wager) > 0 ? toNumber(finalBalanceInfo.wager) : bet,
            resultAmount: win,
            balance,
        },
        freeChoiceOptionCount: optionCount,
        freeChoiceOptionIndex: optionIndex,
        // wager→Spin、play→jackpotplay 同样是完整大局的后续请求，不能只保留免费玩法。
        freeChoiceSteps: steps,
        roundEvents: [initialRequest.event, ...steps.map((step) => step.event)],
        winResolution: {
            method: winResolution.method,
            protocolWin: winResolution.protocolWin,
            balanceDerivedWin: winResolution.balanceDerivedWin,
            difference: winResolution.balanceDerivedWin === null
                ? null
                : winResolution.balanceDerivedWin - winResolution.protocolWin,
        },
        requiresSessionReset,
    };

    return {
        isFeature,
        optionIndex,
        optionCount,
        bet,
        win,
        data,
        balance,
    };
}
