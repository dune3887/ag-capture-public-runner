import { randomUUID } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import WebSocket from 'ws';
import {
    DEFAULT_CURRENCY,
    DEFAULT_LANGUAGE,
} from '../config';
import { AGGameConfig } from './ag.types';
import { AGPickProtocol, AGProviderResponseError, hasExplicitXmlBalance } from './ag.round';

interface CometDMessage {
    id?: string;
    channel: string;
    clientId?: string;
    version?: string;
    minimumVersion?: string;
    supportedConnectionTypes?: string[];
    connectionType?: string;
    subscription?: string;
    advice?: Record<string, any>;
    data?: Record<string, any>;
    successful?: boolean;
    ext?: Record<string, any>;
}

interface PendingMessage {
    resolve: (msg: CometDMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = Number(process.env.AG_REQUEST_TIMEOUT_MS || 20000);
const WS_URL_PREFIX = process.env.AG_WS_URL_PREFIX || 'wss://platform.us-nj.roxor.games/comms-api/v1/dfkj';
const TRACE_PROTOCOL = process.env.AG_PROTOCOL_TRACE === '1';
export const CAPTURE_COIN_SIZE = process.env.COIN || '';

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
});

function asArray<T>(value: T | T[] | null | undefined): T[] {
    if (value === null || value === undefined) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function parseCsvNumbers(value: unknown): number[] {
    if (value === null || value === undefined || String(value).trim() === '') {
        return [];
    }
    return String(value || '')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item));
}

function expandXmlBets(value: unknown): number[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => Number(item))
            .filter((item) => Number.isFinite(item) && item > 0);
    }

    const values = parseCsvNumbers(value);
    if (values.length === 1 && Number.isInteger(values[0]) && values[0] > 1) {
        return Array.from({ length: values[0] }, () => 1);
    }
    return values;
}

function parseXmlNumberTree(value: unknown): number[] {
    if (value === null || value === undefined) {
        return [];
    }
    if (typeof value !== 'object') {
        return parseCsvNumbers(value);
    }
    const result: number[] = [];
    for (const child of Object.values(value as Record<string, any>)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                result.push(...parseXmlNumberTree(item));
            }
        } else {
            result.push(...parseXmlNumberTree(child));
        }
    }
    return result.filter((item) => Number.isFinite(item));
}

function firstFiniteNumber(...values: unknown[]): number {
    for (const value of values) {
        const numberValue = Number(value);
        if (Number.isFinite(numberValue)) {
            return numberValue;
        }
    }
    return 0;
}

function getXmlEvent(events: Record<string, any>, name: string): Record<string, any> | null {
    const value = events[name];
    const first = asArray(value)[0];
    return first && typeof first === 'object' ? first : null;
}

function hasXmlEvent(events: Record<string, any>, name: string): boolean {
    return events[name] !== undefined;
}

function sumXmlWins(events: Record<string, any>): number {
    let total = 0;
    for (const [name, value] of Object.entries(events)) {
        if (!/(Win|Award|Payout|BonusResult)/i.test(name) || /Metadata/i.test(name)) {
            continue;
        }
        for (const item of asArray(value)) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const amount = firstFiniteNumber(
                item.grossWin,
                item.win,
                item.amount,
                item.payout,
                item.totalWin,
                item.winAmount,
            );
            total += amount;
        }
    }
    return total;
}

function isXmlRoundRequest(event: string): boolean {
    return /(spin|cascade|respin|pick|wager|play|reward)/i.test(event);
}

function resolveXmlNextAction(events: Record<string, any>, event: string): string {
    const eventNames = Object.keys(events);
    const findEnableEvent = (pattern: RegExp) => eventNames.find((name) => /^Enable.*Event$/i.test(name) && pattern.test(name));
    const freeSpinCountEventName = eventNames.find((name) => /Update.*FreeSpin.*CountEvent/i.test(name));
    const freeSpinCountEvent = freeSpinCountEventName
        ? getXmlEvent(events, freeSpinCountEventName)
        : null;
    const hasFreeSpinStateEvent = eventNames
        .some((name) => /^(?:Show|Update|Resume|Extend).*FreeSpin/i.test(name));

    if (findEnableEvent(/Free.*Cascade|Cascade.*Free/i)) {
        return 'FREE_CASCADE';
    }
    if (findEnableEvent(/Cascade/i)) {
        return hasFreeSpinStateEvent ? 'FREE_CASCADE' : 'CASCADE';
    }
    if (findEnableEvent(/Reward.*Spin/i)) {
        return 'REWARD_SPIN';
    }
    if (findEnableEvent(/Free.*Spin/i)) {
        return 'FREE_SPIN';
    }
    if (findEnableEvent(/Respin/i)) {
        return 'RESPIN';
    }
    if (findEnableEvent(/Pick|Selection|Bonus/i)) {
        return 'PICK';
    }
    // 旧版 XML 游戏不会发送 Enable*Event，而是直接用奖励事件推进状态。
    if (hasXmlEvent(events, 'StartFreeSpinsEvent')) {
        return 'FREE_SPIN';
    }
    if (freeSpinCountEvent && Number(freeSpinCountEvent.freeSpinsRemaining) > 0) {
        return 'FREE_SPIN';
    }
    if (hasXmlEvent(events, 'PickBonusEvent')) {
        return 'PICK';
    }
    if (hasXmlEvent(events, 'MultiRoundPickBonusEvent')) {
        return 'PICK';
    }
    if (hasXmlEvent(events, 'RoundEvent')) {
        return 'PICK';
    }
    if (
        hasXmlEvent(events, 'PickBonusResultEvent')
        || hasXmlEvent(events, 'GameOverEvent')
        || hasXmlEvent(events, 'GameFinishedEvent')
        || hasXmlEvent(events, 'EnableGameEvent')
    ) {
        return 'SPIN';
    }
    // Fortune Temple 的有状态模式在 NextRoundEvent 后请求 RoundPickEvent，收到 RoundEvent 才允许下一次 Pick。
    // 无状态多轮模式的 isLast="true" 则直接进入下一次 Pick，两种状态不能混为一谈。
    if (hasXmlEvent(events, 'NextRoundEvent')) {
        return 'NEXT_PICK_ROUND';
    }
    // isLast 在不同旧版游戏中的语义并不一致；没有结果/结束事件的普通 PickItemEvent 仍处于选择流程。
    // 没有结果/结束事件的 PickItemEvent 也仍处于选择流程中（包括空节点）。
    if (hasXmlEvent(events, 'PickItemEvent')) {
        return 'PICK';
    }

    if (isXmlRoundRequest(event)) {
        const runtimeError = events.RuntimeErrorEvent;
        const details = runtimeError === undefined ? '' : ` details=${JSON.stringify(runtimeError)}`;
        throw new Error(`${event}: XML response missing supported next action: ${eventNames.join(',') || '(empty Events)'}${details}`);
    }
    return '';
}

function parseXmlPickGameInfo(events: Record<string, any>): Record<string, any> | undefined {
    const pickEvent = getXmlEvent(events, 'ShowPickGameEvent')
        || getXmlEvent(events, 'ResumePickGameEvent');
    const pickRound = pickEvent?.PickRound;
    if (!pickRound || typeof pickRound !== 'object') {
        if (hasXmlEvent(events, 'NextRoundEvent')) {
            return undefined;
        }
        if (hasXmlEvent(events, 'MultiRoundPickBonusEvent')) {
            return {
                requestMode: 'legacy-multiround-pick',
                requestEvent: 'Pick',
            };
        }
        if (hasXmlEvent(events, 'PickBonusEvent')) {
            const pickBonusEvent = getXmlEvent(events, 'PickBonusEvent');
            const initiatingLines = String(pickBonusEvent?.initiatingLines || '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
            return {
                requestMode: pickBonusEvent?.grossWin === undefined
                    ? 'legacy-stateful-spin-pick'
                    : 'legacy-preloaded-pick',
                requestEvent: 'Pick',
                bonusMultiplier: Math.max(initiatingLines.length, 1),
            };
        }
        const isLegacySequentialPick = hasXmlEvent(events, 'PickBonusEvent')
            || hasXmlEvent(events, 'RoundEvent')
            || (
                hasXmlEvent(events, 'PickItemEvent')
                && !hasXmlEvent(events, 'PickBonusResultEvent')
                && !hasXmlEvent(events, 'GameOverEvent')
                && !hasXmlEvent(events, 'GameFinishedEvent')
                && !hasXmlEvent(events, 'EnableGameEvent')
            );
        if (!isLegacySequentialPick) {
            return undefined;
        }

        // Tiki Island 等旧游戏使用 Pick + 0-based 递增索引，且不接受 PickRequest 参数。
        return {
            requestMode: 'legacy-sequential-pick',
            requestEvent: 'Pick',
        };
    }

    const rawOptions = asArray(pickRound.PickOption)
        .filter((option) => option && typeof option === 'object');
    const pickOptions = rawOptions
        .filter((option) => String(option.state || 'AVAILABLE').toUpperCase() === 'AVAILABLE')
        .map((option) => {
            const requestPickIndex = Number(option.pickIndex);
            return {
                ...option,
                // 数据库选择项从 1 开始，协议请求仍保留服务端的 0-based index。
                pickIndex: Number.isFinite(requestPickIndex) ? requestPickIndex + 1 : option.pickIndex,
                requestPickIndex: option.pickIndex,
            };
        });

    return {
        pickOptions,
        optionCount: firstFiniteNumber(pickRound.optionsAvailable, rawOptions.length),
        picksRemaining: firstFiniteNumber(pickRound.picksRemaining),
        roundIndex: firstFiniteNumber(pickRound.roundIndex),
    };
}

function findXmlValue(value: unknown, names: string[]): unknown {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const wanted = new Set(names.map((name) => name.toLowerCase()));
    for (const [key, child] of Object.entries(value as Record<string, any>)) {
        if (wanted.has(key.toLowerCase())) {
            return child;
        }
    }
    for (const child of Object.values(value as Record<string, any>)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                const found = findXmlValue(item, names);
                if (found !== undefined) {
                    return found;
                }
            }
        } else {
            const found = findXmlValue(child, names);
            if (found !== undefined) {
                return found;
            }
        }
    }
    return undefined;
}

function genesisNextAction(root: Record<string, any>): string {
    const explicit = findXmlValue(root, ['NextAction', 'nextAction']);
    if (explicit !== undefined && String(explicit).trim()) {
        return String(explicit).trim().toUpperCase();
    }

    const state = String(findXmlValue(root, ['GameState']) || '').toUpperCase();
    // Genesis 把免费局最后一帧标成 PostFreeSpins；其中虽然包含 FREE，
    // 但客户端下一步已经回到普通 Spin，不能再补采一条空 FreeSpin。
    if (state.startsWith('POST')) {
        return 'SPIN';
    }
    if (state.includes('FREE')) {
        return 'FREE_SPIN';
    }
    if (state.includes('RESPIN')) {
        return 'RESPIN';
    }
    if (state.includes('PICK') || state.includes('BONUS')) {
        return 'PICK';
    }
    return 'SPIN';
}

function parseGenesisXmlResponse(parsed: Record<string, any>, event: string): Record<string, any> {
    const rootName = Object.keys(parsed).find((name) => !name.startsWith('?') && !name.startsWith('#')) || '';
    const root = parsed[rootName];
    if (!root || typeof root !== 'object') {
        throw new Error(`${event}: unsupported XML response`);
    }

    const coinSize = firstFiniteNumber(
        findXmlValue(root, ['CurrentCoinSize']),
        findXmlValue(root, ['DefaultCoinSize']),
        findXmlValue(root, ['CoinSize']),
    );
    const currentBets = expandXmlBets(findXmlValue(root, ['CurrentBets', 'NumberOfCoins']));
    const availableBets = expandXmlBets(findXmlValue(root, ['AvailableBets']));
    const balance = firstFiniteNumber(findXmlValue(root, ['Balance', 'PlayerBalance', 'CurrentBalance', 'PostSpinBalance']));
    const wager = firstFiniteNumber(findXmlValue(root, ['Wager', 'TotalBet', 'BetAmount']));
    const win = firstFiniteNumber(findXmlValue(root, ['TotalWin', 'GrossWin', 'WinAmount', 'ResultAmount']));
    const gameReference = findXmlValue(root, ['GameReference', 'GameReferenceId', 'RoundId', 'GroupId', 'GamePlayId']);
    const coinSizesValue = findXmlValue(root, ['CoinSizes', 'AvailableCoinSizes']);

    return {
        AGProtocolInfo: { format: 'genesis-xml', rootName },
        GameReferenceInfo: gameReference ? { gameReference: String(gameReference) } : undefined,
        GameWageringInfo: {
            currentCoinSize: coinSize,
            defaultCoinSize: coinSize,
            availableCoinSizes: Array.isArray(coinSizesValue)
                ? coinSizesValue.map(Number).filter(Number.isFinite)
                : parseXmlNumberTree(coinSizesValue),
            currentBets: currentBets.length > 0 ? currentBets : availableBets,
            availableBets,
        },
        PlayerBalanceInfo: {
            balance,
            wager,
            resultAmount: win,
        },
        GameSlotResultInfo: { grossWin: win },
        NextActionInfo: { nextAction: genesisNextAction(root) },
        GenesisResponse: root,
    };
}

function parseXmlResponseText(text: string, event: string): Record<string, any> {
    const parsed = xmlParser.parse(text);
    const events = parsed?.Events;
    if (!events || typeof events !== 'object') {
        throw new Error(`${event}: unsupported XML response`);
    }
    if (hasXmlEvent(events, 'MalformedRequestEvent')) {
        throw new Error(`${event}: ${JSON.stringify({ type: 'MalformedRequest' })}`);
    }

    const gameOverEvent = getXmlEvent(events, 'GameOverEvent');
    const pickBonusEvent = getXmlEvent(events, 'PickBonusEvent')
        || getXmlEvent(events, 'MultiRoundPickBonusEvent');
    const pickBonusResultEvent = getXmlEvent(events, 'PickBonusResultEvent');
    const balanceEvent = gameOverEvent || pickBonusResultEvent || pickBonusEvent || getXmlEvent(events, 'SetBalanceEvent');
    const countUpBalanceEvent = getXmlEvent(events, 'CountUpBalanceEvent');
    const updateBalanceEvent = getXmlEvent(events, 'UpdateBalancePostWagerEvent');
    const displayWinEvent = getXmlEvent(events, 'DisplayWinEvent');
    const freeSpinCountEventName = Object.keys(events)
        .find((name) => /Update.*FreeSpin.*CountEvent/i.test(name));
    const freeSpinCountEvent = freeSpinCountEventName
        ? getXmlEvent(events, freeSpinCountEventName)
        : null;
    const coinEvent = getXmlEvent(events, 'SetCoinSizesEvent')
        || getXmlEvent(events, 'GameMetadataEvent');
    const betsEvent = getXmlEvent(events, 'SetBetsEvent');
    const referenceEvent = getXmlEvent(events, 'ShowGameReferenceEvent')
        || getXmlEvent(events, 'GameOverEvent')
        || getXmlEvent(events, 'GameMetadataEvent');
    const parsedWins = sumXmlWins(events);
    const win = parsedWins > 0
        ? parsedWins
        : firstFiniteNumber(
            gameOverEvent?.win,
            gameOverEvent?.resultAmount,
            gameOverEvent?.grossWin,
            pickBonusResultEvent?.grossWin,
            pickBonusEvent?.grossWin,
        );
    const gameReference = referenceEvent?.gameReference || referenceEvent?.groupId;

    return {
        AGProtocolInfo: { format: 'events-xml' },
        GameReferenceInfo: gameReference ? { gameReference } : undefined,
        GameWageringInfo: {
            currentCoinSize: firstFiniteNumber(betsEvent?.coinSize, coinEvent?.defaultCoinSize),
            defaultCoinSize: firstFiniteNumber(coinEvent?.defaultCoinSize, betsEvent?.coinSize),
            availableCoinSizes: parseCsvNumbers(coinEvent?.coinSizes),
            currentBets: parseCsvNumbers(betsEvent?.currentBets),
            availableBets: parseCsvNumbers(betsEvent?.availableBets),
        },
        PlayerBalanceInfo: {
            balance: firstFiniteNumber(
                gameOverEvent?.balance,
                pickBonusResultEvent?.balance,
                pickBonusEvent?.balance,
                countUpBalanceEvent?.to,
                balanceEvent?.balance,
                updateBalanceEvent?.balance,
                displayWinEvent?.balance,
            ),
            wager: firstFiniteNumber(displayWinEvent?.wager),
            resultAmount: win,
        },
        GameSlotResultInfo: {
            grossWin: win,
        },
        PickGameInfo: parseXmlPickGameInfo(events),
        FreeSpinsInfo: freeSpinCountEvent
            ? {
                freeSpinsRemaining: firstFiniteNumber(freeSpinCountEvent.freeSpinsRemaining),
                accumulativeWin: firstFiniteNumber(freeSpinCountEvent.winTotal),
                multiplier: firstFiniteNumber(freeSpinCountEvent.multiplier),
            }
            : undefined,
        NextActionInfo: {
            nextAction: resolveXmlNextAction(events, event),
        },
        XmlEvents: events,
    };
}

export function parseResponseText(msg: CometDMessage, event: string): Record<string, any> {
    const text = msg.data?.responseText;
    if (!text) {
        throw new Error(`${event}: missing responseText`);
    }

    const value = String(text).trim();
    let data: Record<string, any>;
    if (value.startsWith('<')) {
        const parsed = xmlParser.parse(value);
        data = parsed?.Events
            ? parseXmlResponseText(value, event)
            : parseGenesisXmlResponse(parsed, event);
    } else {
        data = JSON.parse(value);
    }
    if (data && !Array.isArray(data) && Object.keys(data).length === 1
        && Object.prototype.hasOwnProperty.call(data, 'error')) {
        throw new AGProviderResponseError(event, 'error-only');
    }
    if (data?.ErrorInfo?.type === 'MalformedRequest') {
        throw new AGProviderResponseError(event, 'MalformedRequest');
    }
    if (data?.ErrorInfo) {
        throw new Error(`${event}: ${JSON.stringify(data.ErrorInfo)}`);
    }

    return data;
}

export function buildLowercaseFollowUpCandidates(
    event: string,
    parameters: Record<string, any> | null,
): Array<{ event: string; parameters: Record<string, any> | null }> {
    const normalized = event.toLowerCase();
    const lowercaseMap: Record<string, string> = {
        freespin: 'freeSpin',
        freespins: 'freeSpin',
        freecascade: 'freespincascade',
        freespincascade: 'freespincascade',
        rewardspin: 'rewardSpin',
    };
    const canonicalMap: Record<string, string> = {
        cascade: 'Cascade',
        freecascade: 'FreeCascade',
        freespincascade: 'FreeCascade',
        freespin: 'FreeSpin',
        freespins: 'FreeSpin',
        rewardspin: 'RewardSpin',
        pick: 'Pick',
        respin: 'Respin',
    };
    const primaryEvent = lowercaseMap[normalized] || normalized;
    const canonicalEvent = canonicalMap[normalized];
    const candidates: Array<{ event: string; parameters: Record<string, any> | null }> = [];
    const addCandidate = (candidateEvent: string, candidateParameters: Record<string, any> | null) => {
        const key = `${candidateEvent}:${JSON.stringify(candidateParameters || {})}`;
        if (!candidates.some((candidate) => `${candidate.event}:${JSON.stringify(candidate.parameters || {})}` === key)) {
            candidates.push({ event: candidateEvent, parameters: candidateParameters });
        }
    };
    const addCanonicalCandidate = (candidateEvent: string | undefined) => {
        if (!candidateEvent) {
            return;
        }
        const candidateParameters = /^(Cascade|FreeCascade|FreeSpin|RewardSpin)$/.test(candidateEvent)
            ? { autoPlay: 'false' }
            : parameters;
        addCandidate(candidateEvent, candidateParameters);
    };

    addCandidate(primaryEvent, parameters);
    addCanonicalCandidate(canonicalEvent);

    // 一些旧游戏在免费旋转中仍返回 EnableCascadeEvent，单靠事件名无法区分普通连锁与免费连锁。
    // 两组协议都只在前一组明确返回 MalformedRequest/RuntimeError 后继续协商。
    if (normalized === 'cascade') {
        addCandidate('freespincascade', parameters);
        addCanonicalCandidate('FreeCascade');
    } else if (normalized === 'freecascade' || normalized === 'freespincascade') {
        addCandidate('cascade', parameters);
        addCanonicalCandidate('Cascade');
    }
    return candidates;
}

function parseNumberList(values: any): number[] {
    if (!Array.isArray(values)) {
        return [];
    }

    return values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
}

export function resolveCaptureCoinSize(game: AGGameConfig, wagering: Record<string, any>): string {
    return String(CAPTURE_COIN_SIZE || wagering.currentCoinSize || wagering.defaultCoinSize || game.defaultCoinSize || '0.01');
}

export function buildSpinParams(
    coinSize: string,
    numberOfCoins: string,
    activeSymbols?: Record<string, any> | string | null,
): Record<string, any> {
    const params: Record<string, any> = {
        coinSize,
        numberOfCoins,
    };
    if (activeSymbols && (typeof activeSymbols !== 'object' || Object.keys(activeSymbols).length > 0)) {
        params.activeSymbols = typeof activeSymbols === 'string'
            ? activeSymbols
            : JSON.stringify(activeSymbols);
    }
    return params;
}

export function buildLegacySpinParams(coinSize: string, numberOfCoins: string): Record<string, any> {
    return { autoPlay: 'false', coinSize, numberOfCoins };
}

export function buildFollowUpParams(coinSize: string, numberOfCoins: string): Record<string, any> {
    return {
        coinSize,
        numberOfCoins,
    };
}

export function buildPickParams(
    coinSize: string,
    numberOfCoins: string,
    pickIndex: number | string,
): Record<string, any> {
    return {
        coinSize,
        numberOfCoins,
        pickIndex: String(pickIndex),
    };
}

export class RoxorCometDSession {
    private ws: WebSocket | null = null;
    private clientId = '';
    private seq = 1;
    private readonly pending = new Map<string, PendingMessage>();
    private handshakeData: Record<string, any> | null = null;
    private lastGameRequest: { event: string; parameters: Record<string, any> | null } | undefined;
    private balance = Number.NaN;
    private lastResponseAction = '';
    private completedRequests = 0;
    private readonly openedAt = Date.now();
    private diagnosticPickIndexes: number[] = [];
    private coinSize = '0.01';
    private numberOfCoins = '1';
    private lineSum = 1;
    private protocol: 'standard' | 'lowercase-standard' | 'legacy-events' | 'wager-first' | 'instant' | 'genesis' = 'standard';
    private activeSymbols: Record<string, any> | string | null = null;

    constructor(private readonly game: AGGameConfig) {}

    async connect(): Promise<void> {
        if (!this.game.backendId) {
            throw new Error(`missing backendId: ${this.game.gameId}`);
        }

        const url = `${WS_URL_PREFIX}/${this.game.backendId}/cometd`;
        this.ws = new WebSocket(url, {
            headers: {
                Origin: 'https://cdn.us-nj.roxor.games',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',
            },
        });
        this.ws.on('message', (raw) => this.onMessage(String(raw)));
        this.ws.on('close', (code) => this.rejectPending(new Error(`websocket closed: ${code}`)));
        this.ws.on('error', (error) => this.rejectPending(error instanceof Error ? error : new Error(String(error))));

        await new Promise<void>((resolve, reject) => {
            this.ws!.once('open', () => resolve());
            this.ws!.once('error', reject);
        });

        const handshake = await this.send({
            channel: '/meta/handshake',
            version: '1.0',
            minimumVersion: '1.0',
            supportedConnectionTypes: ['websocket'],
            advice: { timeout: 60000, interval: 0 },
            ext: {
                correlationId: randomUUID(),
                country: 'US',
                operator: 'dfkj',
                website: 'dfkj',
                gameKey: this.game.gameId,
                platform: 'desktop',
                language: DEFAULT_LANGUAGE,
                currency: DEFAULT_CURRENCY,
                playMode: 'GUEST',
                host: '',
                authentication: {
                    memberId: `GUEST-${randomUUID()}`,
                    secureToken: 'GUEST',
                },
                CamelHeaders: {
                    correlationId: randomUUID(),
                    wrapperSessionUUid: randomUUID(),
                },
            },
        });
        if (!handshake.successful || !handshake.clientId) {
            throw new Error(`handshake failed: ${JSON.stringify(handshake)}`);
        }

        this.clientId = handshake.clientId;
        await this.send({ channel: '/meta/connect', clientId: this.clientId, connectionType: 'websocket' });
        await this.callPlatform('getRewards');
        await this.callPlatform('getSessionID');
        await this.subscribe('/subscribe/game/notifications');
        await this.subscribe('/subscribe/platform/notifications');
        await this.callGameRaw('paytable', null);
        const handshakeEvent = this.game.artifactPath?.includes('/js-instant-') ? 'handshake' : 'Handshake';
        this.handshakeData = await this.callGameData(handshakeEvent, {});
        this.detectProtocol();
        if (this.protocol === 'legacy-events') {
            try {
                const coinData = await this.callGameData('GetCoinSizesEvent', null);
                const refreshed = await this.callGameData('Handshake', null);
                this.handshakeData = this.mergeHandshakeData(this.handshakeData, coinData, refreshed);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!/MalformedRequest/i.test(message)) {
                    throw error;
                }
                console.log(`[protocol] ${this.game.gameId} 不支持 GetCoinSizesEvent，探测小写事件协议`);
                this.handshakeData = await this.callGameData('handshake', {});
                this.protocol = 'lowercase-standard';
            }
        }
        this.updateActiveSymbols(this.handshakeData);
        this.deriveWager();
    }

    close(): void {
        this.rejectPending(new Error('session closed'));
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // ignore close errors
            }
            this.ws = null;
        }
    }

    getHandshakeData(): Record<string, any> | null {
        return this.handshakeData;
    }

    getLastGameRequest() {
        return this.lastGameRequest && structuredClone(this.lastGameRequest);
    }

    getBalance(): number { return this.balance; }

    getFallbackBet(): number {
        return Number(this.coinSize) * this.lineSum;
    }

    getSpinParams(): Record<string, any> {
        if (this.protocol === 'legacy-events') {
            return buildLegacySpinParams(this.coinSize, this.numberOfCoins);
        }
        // 官方 Wicked Winnings II 1.0.7 只发送投注两字段，不附带通用缓存。
        if (this.game.backendArtifactId === 'rgp-game-wicked-winnings-2') {
            return buildSpinParams(this.coinSize, this.numberOfCoins);
        }
        return buildSpinParams(this.coinSize, this.numberOfCoins, this.activeSymbols);
    }

    getFollowUpParams(): Record<string, any> {
        return buildFollowUpParams(this.coinSize, this.numberOfCoins);
    }

    getPickParams(pickIndex: number | string): Record<string, any> {
        // Turtle Kingdom 1.0.6 官方奖池揭示只发送字符串索引，不附加投注字段。
        if (this.game.backendArtifactId === 'rgp-game-gold-stacks-88-turtle-kingdom') return { pickIndex: String(pickIndex) };
        // Christmas Cottage 旧 Servlet 的 PickRequest 经 CometD 发送时保留表单字符串类型。
        if (this.game.backendArtifactId === 'rgp-game-christmas-cottage') {
            return { roundIndex: '0', pickIndex: String(pickIndex), autoPick: 'false' };
        }
        if (this.protocol === 'lowercase-standard') {
            return { pickIndex: String(pickIndex) };
        }
        if (this.protocol === 'legacy-events') {
            return { roundIndex: 0, pickIndex: String(pickIndex), autoPick: false };
        }
        return buildPickParams(this.coinSize, this.numberOfCoins, pickIndex);
    }

    getPickProtocol(action: string, response: Record<string, any>, revealedIndexes: readonly number[] = []): AGPickProtocol | undefined {
        // Lunar Festival 1.0.24 用 id 区分五选一免费玩法和 12 格奖池，响应可能保留旧奖池字段。
        const lunar = this.game.backendArtifactId === 'rgp-game-gold-stacks-88-lunar-festival';
        // Royal Monkey 1.0.3：免费选择协议 ID 为 1..3（UI 映射 1、3、2）。
        const royalMonkey = this.game.backendArtifactId === 'rgp-game-gold-stacks-88-royal-monkey';
        const pickKind = response.NextActionInfo?.id;
        if ((lunar || royalMonkey) && action === 'PICK') {
            if (pickKind === 'FREE_GAME_PICK') {
                // 官方 sw 映射：四种固定免费玩法为 1..4，MYSTERY 为 5；与 UI 位置不同。
                return {event: 'Pick', kind: 'choice', options: Array.from({length: royalMonkey ? 3 : 5}, (_, index) => ({pickIndex: index + 1, requestPickIndex: index + 1}))};
            }
            if (pickKind !== 'JACKPOT') throw new Error(royalMonkey ? 'AG integrity: unknown Royal Monkey Pick branch' : 'AG integrity: unknown Lunar Pick branch');
        }
        // 官方 Turtle 1.0.6 / Dancing Foo 1.0.12：每盘 12 格，RESET 清盘，RESUME 只恢复当前揭示集合。
        // 同一大局可以多次进入奖池，不能沿用整局递增索引或上一盘本地历史。
        if (action === 'PICK' && ['rgp-game-gold-stacks-88-turtle-kingdom',
            'rgp-game-gold-stacks-88-dancing-foo'].includes(this.game.backendArtifactId || '') || ((lunar || royalMonkey) && action === 'PICK' && pickKind === 'JACKPOT')) {
            const info = response.JackpotPickResultInfo;
            const revealed = info === undefined ? [] : info?.revealedSymbols;
            if (!Array.isArray(revealed)) throw new Error('AG integrity: invalid jackpot revealedSymbols');
            const picked = new Set<number>();
            for (const symbol of revealed) {
                const raw = symbol?.pickIndex;
                const index = Number(raw);
                if ((typeof raw !== 'number' && typeof raw !== 'string') || String(raw).trim() === ''
                    || !Number.isInteger(index) || index < 0 || index >= 12 || picked.has(index)) {
                    throw new Error('AG integrity: invalid jackpot revealed pick index');
                }
                picked.add(index);
            }
            return {event: 'Pick', kind: 'reveal', remapReveal: true, revealedIndexes: [...picked],
                options: Array.from({length: 12}, (_, index) => ({pickIndex: index + 1, requestPickIndex: index}))
                    .filter(option => !picked.has(option.requestPickIndex))};
        }
        // 官方 Heart of the Sea 1.0.7 / Grand Prosperity 1.0.2：
        // 免费次数四选一用 pickfreespins；Match3 的 Pick 揭示 12 格，二者不能共享索引计数器。
        if (!['rgp-game-triple-supreme-xtreme-heart-of-the-sea',
            'rgp-game-triple-supreme-xtreme-grand-prosperity'].includes(this.game.backendArtifactId || '')) return undefined;
        if (action === 'PICK_FREE_SPINS') {
            return {event: 'pickfreespins', kind: 'choice', options: Array.from({length: 4}, (_, index) => ({pickIndex: index + 1, requestPickIndex: index}))};
        }
        if (action !== 'PICK') return undefined;
        const revealed = response.Match3Result?.revealedSymbols;
        // 普通入口不带 revealedSymbols，客户端在每次成功揭示后维护本地已选格子。
        if (revealed !== undefined && !Array.isArray(revealed)) throw new Error('AG integrity: invalid Match3 revealedSymbols');
        const picked = new Set<number>();
        for (const symbol of revealed || []) {
            const raw = symbol?.pickIndex;
            const index = Number(raw);
            if ((typeof raw !== 'number' && typeof raw !== 'string') || String(raw).trim() === ''
                || !Number.isInteger(index) || index < 0 || index >= 12 || picked.has(index)) {
                throw new Error('AG integrity: invalid Match3 revealed pick index');
            }
            picked.add(index);
        }
        for (const index of revealedIndexes) picked.add(index);
        return {event: 'Pick', kind: 'reveal', revealedIndexes: [...picked], options: Array.from({length: 12}, (_, index) => ({pickIndex: index + 1, requestPickIndex: index}))
            .filter(option => !picked.has(option.requestPickIndex))};
    }

    getPickEvent(): string {
        if (this.game.backendArtifactId === 'rgp-game-gold-stacks-88-turtle-kingdom') return 'Pick';
        if (this.game.backendArtifactId === 'rgp-game-christmas-cottage') return 'PickRequest';
        return this.protocol === 'legacy-events' ? 'PickRequest' : '';
    }

    getLegacyPickCompletionRequest(mode: string): {event: string; parameters: Record<string, any>} | undefined {
        // Fortune Temple 3.0.5 的 stateful 转盘 COLLECT 后用 -1 请求最终结算。
        if (this.game.backendArtifactId === 'rgp-game-fortunetemple' && mode === 'legacy-stateful-spin-pick') {
            return {event: 'Pick', parameters: {pickIndex: '-1'}};
        }
        return undefined;
    }

    getSequentialPickIndex(index: number, trigger: Record<string, any>): number {
        // Tiki Island 4.0.5 官方客户端：椰子选未点位置；鱼奖励每轮重新展示三条鱼，
        // 请求为 3 * roundIdx + clickedIndex。采集固定点每轮第一条，不能发送 0、1、2。
        // 该 XML 协议没有在响应中声明索引步长，不应把此规则套到其他旧式 Pick 游戏。
        return this.game.backendArtifactId === 'rgp-game-tiki-island'
            && trigger.XmlEvents?.PickBonusEvent?.id !== undefined
            && String(trigger.XmlEvents.PickBonusEvent.id) !== '1' ? index * 3 : index;
    }

    getInitialRoundRequest(): { event: string; parameters: Record<string, any> | null } {
        if (this.protocol === 'wager-first') {
            return {
                event: 'wager',
                parameters: { coinSize: this.coinSize, numberOfCoins: this.numberOfCoins },
            };
        }
        if (this.protocol === 'instant') {
            return { event: 'play', parameters: { wager: Number(this.coinSize).toFixed(2) } };
        }
        if (this.protocol === 'lowercase-standard') {
            return { event: 'spin', parameters: this.getSpinParams() };
        }
        return { event: 'Spin', parameters: this.getSpinParams() };
    }

    getActionParams(_action: string, event: string): Record<string, any> | null {
        if (this.protocol === 'wager-first' || this.protocol === 'instant') {
            return {};
        }
        if (this.protocol === 'lowercase-standard' && event.toLowerCase() !== 'spin') {
            return {};
        }
        if (this.protocol === 'legacy-events' && /free.*spin/i.test(event)) {
            return { autoPlay: 'false' };
        }
        if (this.protocol === 'legacy-events' && event === 'RoundPickEvent') {
            return null;
        }
        // 已核对的 Cash Express Legend / CELL 官方客户端：nexttrain 不带投注参数。
        if (event === 'nexttrain' || event === 'BonusSpin') {
            return {};
        }
        if (event.toLowerCase() === 'spin') {
            return this.getSpinParams();
        }
        return this.getFollowUpParams();
    }

    isRoundTerminalAction(action: string): boolean {
        const value = String(action || '').trim().toUpperCase();
        if (this.protocol === 'wager-first') {
            return value === 'WAGER';
        }
        if (this.protocol === 'instant') {
            return value === 'PLAY';
        }
        return value === '' || value === 'SPIN' || value === 'BASE' || value === 'NORMAL';
    }

    async callGameData(event: string, parameters: Record<string, any> | null): Promise<Record<string, any>> {
        let data: Record<string, any>;
        if (this.protocol === 'legacy-events' && event === 'Spin') {
            data = await this.callLegacySpin(parameters);
        } else if (this.protocol === 'lowercase-standard' && event.toLowerCase() === 'spin') {
            data = await this.callLowercaseSpin(parameters);
        } else if (this.protocol === 'lowercase-standard'
            && !(this.game.backendArtifactId === 'rgp-game-christmas-cottage' && event === 'PickRequest')) {
            data = await this.callLowercaseFollowUp(event, parameters);
        } else {
            const protocolEvent = this.resolveProtocolEvent(event);
            const msg = await this.callGameRaw(protocolEvent, parameters);
            try {
                data = parseResponseText(msg, protocolEvent);
            } catch (error) {
                if (error instanceof AGProviderResponseError && error.reason === 'MalformedRequest') {
                    // 仅白名单投注字段与状态；不输出会话标识或完整服务端响应。
                    const numericParam = (key: string) => {
                        const value = String(parameters?.[key] ?? '');
                        return /^[0-9.,-]{1,500}$/.test(value) ? value : undefined;
                    };
                    console.error('[AG-REJECT] ' + JSON.stringify({gameId:this.game.gameId,event:protocolEvent,reason:error.reason,
                        parameterKeys:Object.keys(parameters || {}).sort(),coinSize:numericParam('coinSize'),numberOfCoins:numericParam('numberOfCoins'),
                        pickIndex:numericParam('pickIndex'),pickIndexType:typeof parameters?.pickIndex,previousRevealedIndexes:this.diagnosticPickIndexes,
                        previousAction:this.lastResponseAction,previousBalance:Number.isFinite(this.balance)?this.balance:null,
                        completedRequests:this.completedRequests,sessionAgeMs:Date.now()-this.openedAt}));
                }
                throw error;
            }
        }
        // 诊断只保留有限的非负整数位置，不保存奖池响应、标识或凭据。
        const diagnosticReveals = data.JackpotPickResultInfo?.revealedSymbols;
        this.diagnosticPickIndexes = Array.isArray(diagnosticReveals) ? diagnosticReveals.slice(0, 32)
            .map((row: any) => row?.pickIndex).filter((index: unknown): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= 1000) : [];
        this.completedRequests += 1;
        this.lastResponseAction = String(data.NextActionInfo?.nextAction || '');
        this.updateActiveSymbols(data);
        const balance = Number(data.PlayerBalanceInfo?.balance);
        if (Number.isFinite(balance) && (balance !== 0 || hasExplicitXmlBalance(data))) this.balance = balance;
        return data;
    }

    private async callLowercaseFollowUp(
        event: string,
        parameters: Record<string, any> | null,
    ): Promise<Record<string, any>> {
        const candidates = buildLowercaseFollowUpCandidates(event, parameters);
        const errors: string[] = [];

        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            try {
                const msg = await this.callGameRaw(candidate.event, candidate.parameters);
                const data = parseResponseText(msg, candidate.event);
                this.updateActiveSymbols(data);
                return data;
            } catch (error) {
                // 保留精确拒绝类型，让上层丢弃整局并重建会话，不能在原会话重发。
                if (error instanceof AGProviderResponseError && error.reason === 'error-only') throw error;
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`${candidate.event}: ${message}`);
                if (index === candidates.length - 1 || !/MalformedRequest|RuntimeError/i.test(message)) {
                    throw new Error(errors.join(' | '));
                }
            }
        }

        throw new Error(`协议协商失败: ${errors.join(' | ')}`);
    }

    private async callLegacySpin(parameters: Record<string, any> | null): Promise<Record<string, any>> {
        const requestedCount = String(parameters?.numberOfCoins || '').split(',').filter(Boolean).length;
        const configuredMinimum = Number(this.game.betMin || this.game.minBet?.replace(/[^0-9.]/g, ''));
        const configuredCoin = Number(this.coinSize);
        const inferredCount = configuredMinimum > 0 && configuredCoin > 0
            ? Math.round(configuredMinimum / configuredCoin)
            : 0;
        const candidates = [...new Set([
            requestedCount,
            inferredCount,
            15, 25, 20, 40, 50, 10, 5, 1, 30, 88, 100, 243,
        ].filter((count) => Number.isInteger(count) && count > 0))];
        const errors: string[] = [];

        for (const count of candidates) {
            const numberOfCoins = Array.from({ length: count }, () => '1').join(',');
            try {
                const msg = await this.callGameRaw('Spin', buildLegacySpinParams(this.coinSize, numberOfCoins));
                const data = parseResponseText(msg, 'Spin');
                this.numberOfCoins = numberOfCoins;
                this.lineSum = count;
                return data;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`${count}线: ${message}`);
                if (!/MalformedRequest/i.test(message)) {
                    throw error;
                }
            }
        }
        throw new Error(`Spin 协议协商失败: ${errors.join(' | ')}`);
    }

    private async callLowercaseSpin(parameters: Record<string, any> | null): Promise<Record<string, any>> {
        const requestedCount = String(parameters?.numberOfCoins || '').split(',').filter(Boolean).length;
        const candidates = [...new Set([
            requestedCount,
            15, 25, 20, 40, 50, 10, 5, 1, 30, 88, 100, 243,
        ].filter((count) => Number.isInteger(count) && count > 0))];
        const errors: string[] = [];

        for (const count of candidates) {
            const numberOfCoins = Array.from({ length: count }, () => '1').join(',');
            try {
                const msg = await this.callGameRaw('spin', buildSpinParams(this.coinSize, numberOfCoins));
                const data = parseResponseText(msg, 'spin');
                this.numberOfCoins = numberOfCoins;
                this.lineSum = count;
                return data;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`${count}线: ${message}`);
                if (!/MalformedRequest/i.test(message)) {
                    throw error;
                }
            }
        }
        throw new Error(`spin 协议协商失败: ${errors.join(' | ')}`);
    }

    private async callGameRaw(event: string, parameters: Record<string, any> | null): Promise<CometDMessage> {
        const response = await this.send({
            channel: '/service/game',
            clientId: this.clientId,
            data: {
                event,
                parameters: parameters == null ? null : JSON.stringify(parameters),
                hasReply: true,
                artifactPath: this.game.artifactPath,
                rewardMode: false,
            },
            ext: { CamelHeaders: { correlationId: randomUUID() } },
        });
        this.lastGameRequest = structuredClone({ event, parameters });
        return response;
    }

    private async subscribe(subscription: string): Promise<void> {
        await this.send({
            channel: '/meta/subscribe',
            clientId: this.clientId,
            subscription,
            ext: { CamelHeaders: { correlationId: randomUUID() } },
        });
    }

    private async callPlatform(event: string, parameters: Record<string, any> | null = null): Promise<CometDMessage> {
        return this.send({
            channel: '/service/platform',
            clientId: this.clientId,
            data: {
                event,
                parameters,
                hasReply: true,
                artifactPath: this.game.artifactPath,
                rewardMode: false,
            },
            ext: { CamelHeaders: { correlationId: randomUUID() } },
        });
    }

    private deriveWager() {
        const wagering = this.handshakeData?.GameWageringInfo || {};
        const coinSize = resolveCaptureCoinSize(this.game, wagering);
        const bets = parseNumberList(wagering.currentBets).length > 0
            ? parseNumberList(wagering.currentBets)
            : parseNumberList(wagering.availableBets);
        const normalizedBets = bets.length > 0 ? bets : [1];

        this.coinSize = String(coinSize);
        this.numberOfCoins = normalizedBets.map((value) => String(value)).join(',');
        this.lineSum = normalizedBets.reduce((sum, value) => sum + value, 0);
    }

    private detectProtocol() {
        this.protocol = 'standard';
        const format = this.handshakeData?.AGProtocolInfo?.format;
        const action = String(this.handshakeData?.NextActionInfo?.nextAction || '').toUpperCase();
        if (format === 'genesis-xml') {
            this.protocol = 'genesis';
        } else if (this.game.artifactPath?.includes('/js-instant-') || action === 'PLAY' || action === 'JACKPOT_PLAY') {
            this.protocol = 'instant';
        } else if (action === 'WAGER') {
            this.protocol = 'wager-first';
        } else if (format === 'events-xml') {
            this.protocol = 'legacy-events';
        }
    }

    private resolveProtocolEvent(event: string): string {
        if (this.protocol !== 'lowercase-standard') {
            return event;
        }
        const eventMap: Record<string, string> = {
            Spin: 'spin',
            FreeSpin: 'freeSpin',
            FreeSpins: 'freeSpin',
            Cascade: 'cascade',
            FreeCascade: 'freespincascade',
            Pick: 'pick',
        };
        return eventMap[event] || event;
    }

    private updateActiveSymbols(data: Record<string, any> | null) {
        const activeSymbols = data?.ActiveSymbols || data?.GameWageringInfo?.activeSymbols;
        if (activeSymbols) {
            this.activeSymbols = activeSymbols;
        }
    }

    private mergeHandshakeData(...values: Array<Record<string, any> | null>): Record<string, any> {
        const merged: Record<string, any> = {};
        for (const value of values) {
            if (!value) {
                continue;
            }
            const previousWagering = merged.GameWageringInfo || {};
            const previousBalance = merged.PlayerBalanceInfo || {};
            Object.assign(merged, value);
            merged.GameWageringInfo = {
                ...previousWagering,
                ...(value.GameWageringInfo || {}),
            };
            merged.PlayerBalanceInfo = {
                ...previousBalance,
                ...(value.PlayerBalanceInfo || {}),
            };
        }
        return merged;
    }

    private async send(msg: CometDMessage): Promise<CometDMessage> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('websocket not connected');
        }

        const id = String(this.seq);
        this.seq += 1;
        msg.id = id;
        const payload = JSON.stringify([msg]);
        if (TRACE_PROTOCOL) {
            console.log(`[AG-PROTOCOL] ${this.game.gameId} client->server ${payload}`);
        }

        return new Promise<CometDMessage>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout waiting cometd id=${id}`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.ws!.send(payload, (error) => {
                if (!error) {
                    return;
                }
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            });
        });
    }

    private onMessage(raw: string) {
        if (TRACE_PROTOCOL) {
            console.log(`[AG-PROTOCOL] ${this.game.gameId} server->client ${raw}`);
        }
        let messages: CometDMessage[];
        try {
            messages = JSON.parse(raw);
        } catch {
            return;
        }

        for (const msg of messages) {
            if (!msg.id) {
                continue;
            }
            const pending = this.pending.get(msg.id);
            if (!pending) {
                continue;
            }

            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            pending.resolve(msg);
        }
    }

    private rejectPending(error: Error) {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }
}
