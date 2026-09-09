import type { ObjectId } from 'mongodb';

export interface AGGameConfig {
    gameId: string;
    name: string;
    dbName?: string;
    serviceDir?: string;
    backendId?: string;
    artifactPath?: string;
    defaultCoinSize?: string;
    coinSizes?: string[];
    numberOfBets?: number;
    rtpBuckets?: number[];
    [key: string]: any;
}

export interface AGMongoDoc {
    _id?: ObjectId;
    bonus: number;
    buy: number;
    data: Record<string, any>;
    mul: number;
    rtp: number[];
    bet: number;
}

export interface AGHandshakeDoc {
    _id: string;
    data: Record<string, any>;
    updatedAt: Date;
}

export interface AGGameLeaseDoc {
    _id: string;
    ownerId: string;
    gameId: string;
    dbName: string;
    hostname?: string;
    pid?: number;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
}

export interface AGMongoCounts {
    events?: Record<string, number>;
    feature?: number;
    base: number;
    total: number;
    optionCount: number;
    freeChoiceOptions: Record<number, number>;
}

export interface AGCaptureLimits {
    featureTarget?: number;
    spinLimit: number;
    freeChoicePerOption: number;
}

export type AGCaptureTaskKind = 'base' | 'choice' | 'feature';

export interface AGCaptureTask {
    key: string;
    kind: AGCaptureTaskKind;
    optionIndex: number;
    target: number;
    current: number;
    missing: number;
    inFlight: number;
}

export interface AGCaptureState {
    tasks: AGCaptureTask[];
    optionCount: number;
    totalCurrent: number;
    totalTarget: number;
    totalMissing: number;
}

export interface AGRoundStep {
    event: string;
    parameters?: Record<string, any> | null;
    action?: string;
    requiresPickIndex?: boolean;
    selectableIndexes?: Array<number | string>;
    data: Record<string, any>;
}

export interface AGCompletedRound {
    isFeature: boolean;
    optionIndex: number;
    optionCount: number;
    bet: number;
    win: number;
    data: Record<string, any>;
    balance?: number;
}
