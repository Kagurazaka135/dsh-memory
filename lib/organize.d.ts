/**
 * 夜间整理引擎（§6）。
 *
 * 流程：扫当天会话 + L2 候选 → 走 broker 归纳 → **只追加** L3 版本（无变化不写）
 *      → 更新 L4 brief（旧版归档，不丢） → 写 log → 记已处理会话台账。
 *
 * 铁律：只追加不删。模型提议的事实若与现状相同 → 不算新版本（unchanged）；
 * broker 失败 → 什么都不写（除 log 里一条失败记录），绝不编造记忆。
 */
import type { MemoryConfig } from './config.ts';
import type { SessionQueryLike } from './host.ts';
export interface OrganizeOptions {
    config: MemoryConfig;
    sessionQuery?: SessionQueryLike;
    signal?: AbortSignal;
    /** true = 只生成报告不改文件（手动试跑用）。 */
    dryRun?: boolean;
    /** 扫描时跳过的会话 id（整理会话自身，默认取 config.organizer_session 或 memory-organizer）。 */
    skipSessionId?: string;
}
export interface OrganizeResult {
    ok: boolean;
    date: string;
    sessionsScanned: number;
    factsCreated: string[];
    factsVersioned: string[];
    candidatesAdded: number;
    briefUpdated: boolean;
    summary?: string;
    error?: string;
    logPath: string;
    notes: string[];
}
interface FactProposal {
    id?: string;
    fact: string;
    value: string;
    source: string[];
    tags: string[];
    note?: string;
}
interface CandidateProposal {
    fact: string;
    source: string[];
    tags: string[];
}
interface OrganizerOutput {
    facts: FactProposal[];
    candidates: CandidateProposal[];
    brief?: string;
    summary?: string;
}
export declare function localDate(now?: Date): string;
export declare function runOrganize(options: OrganizeOptions): Promise<OrganizeResult>;
/** 解析模型输出；非法输出抛错（宁可不写）。 */
export declare function parseOrganizerOutput(raw: string): OrganizerOutput;
export {};
