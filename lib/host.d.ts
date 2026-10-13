/**
 * 宿主服务的结构化最小类型（鸭子类型）。
 *
 * 关键点：本插件**不 import 宿主的任何 dsh-* 内部包**（除了 defineTool 的类型），
 * 只按服务名取用 —— 同一份包要能在 PC / 手机、0.1.x / 0.2.x 各版本宿主上加载。
 * 用到的字段全部可选化处理：服务形态对不上时按 undefined 处理，绝不抛。
 */
export interface SessionHeaderLike {
    id: string;
    createdAt?: number;
    cwd?: string;
    origin?: string;
    agentPreset?: string;
}
export interface SessionLike {
    id: string;
    header?: SessionHeaderLike;
}
export interface SessionsLike {
    get(id: string): SessionLike | undefined;
    create(id: string, options?: {
        meta?: {
            cwd?: string;
        };
    }): SessionLike;
    /** dsh ≥0.2.x：构造但**不进入** store 的会话（用于正规物化路径）。老宿主没有此方法。 */
    prepare?(id: string, options?: {
        meta?: {
            cwd?: string;
        };
    }): SessionLike;
    flush(session: SessionLike): Promise<boolean>;
}
/** 持久化写句柄（`sessionPersistence.create()` 的返回值，最小子集）。 */
export interface PersistenceHandleLike {
    /** 物化：空会话也会在磁盘上生成日志文件。 */
    flush(options?: {
        signal?: AbortSignal;
    }): Promise<void>;
    /** 释放写锁（幂等）。 */
    close(): Promise<void>;
}
/**
 * 会话持久层（dsh ≥0.2.x 的 `sessionPersistence` 服务；鸭子类型，只用到最小子集）。
 *
 * 为什么需要它：schedule 到点投递要经 sessionController 恢复冷会话，
 * 而"已持久化"的判定读的是持久层自己写盘的文件——普通 `sessions.create + flush`
 * 只进内存 store 不写盘，冷恢复会找不到会话。物化必须走这里。
 */
export interface SessionPersistenceLike {
    stat(id: string, options?: {
        signal?: AbortSignal;
    }): Promise<{
        header: SessionHeaderLike;
    } | undefined>;
    create(header: unknown, options?: {
        signal?: AbortSignal;
    }): Promise<PersistenceHandleLike>;
}
export interface ScheduleCreateRequestLike {
    prompt: string;
    title: string;
    daily?: {
        time: string;
        time_zone: string;
    };
    after_seconds?: number;
    at?: string;
}
export interface ScheduleTaskLike {
    id: string;
    title: string;
    prompt?: string;
    sessionId: string;
    status: 'active' | 'inactive';
}
export interface ScheduleLike {
    create(sessionId: string, request: ScheduleCreateRequestLike, signal?: AbortSignal): Promise<{
        id: string;
    }>;
    catalog(): Promise<ScheduleTaskLike[]>;
    delete(request: {
        id: string;
        sessionId: string;
    }): Promise<unknown>;
}
export interface SessionEventLike {
    type: string;
    time?: number;
    data?: Record<string, unknown>;
}
export interface ObservationLike {
    header: SessionHeaderLike;
    events: readonly SessionEventLike[];
}
export interface SessionRecordLike {
    header: SessionHeaderLike;
    live: boolean;
    persisted: boolean;
}
export interface SessionQueryLike {
    listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>;
    observeSession(sessionId: string, options?: {
        signal?: AbortSignal;
        projectionMode?: 'all' | 'none';
    }): Promise<ObservationLike>;
}
export interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
    debug?(message: string): void;
}
/** 一次 apply 里用到的宿主服务集合（缺谁谁 undefined）。 */
export interface HostBundle {
    sessions?: SessionsLike;
    schedule?: ScheduleLike;
    sessionQuery?: SessionQueryLike;
    logger?: LoggerLike;
}
/**
 * 按名取宿主服务（**永不抛**）。
 *
 * Cordis 语义：未在 `inject` 里声明的服务，**读取属性本身就会抛**
 * （`cannot get property "x" without inject`）。所以：
 *  1. 先用 `ctx.get(name)`（Cordis 官方的可选读取入口，未提供时返回 undefined）；
 *  2. 退回属性读取，且包 try/catch（老宿主 / 伪上下文）。
 */
export declare function serviceOf<T>(ctx: unknown, name: string): T | undefined;
export declare function hostBundle(ctx: unknown): HostBundle;
export declare function disposeValue(value: unknown): void;
