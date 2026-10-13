import { type YamlValue } from './yaml.ts';
import type { MemoryConfig } from './config.ts';
export interface FactVersion {
    date: string;
    value: string;
    note?: string;
}
export interface FactRecord {
    id: string;
    fact: string;
    since: string;
    history: FactVersion[];
    source: string[];
    tags: string[];
    updated_at: string;
}
export interface CandidateRecord {
    id: string;
    fact: string;
    first_seen: string;
    last_seen: string;
    count: number;
    source: string[];
    tags: string[];
    status: 'pending' | 'promoted' | 'rejected';
    note?: string;
}
export interface MemoryPaths {
    root: string;
    brief: string;
    facts: string;
    candidates: string;
    logDir: string;
    seen: string;
}
/** DSH_HOME 解析：配置 > `$DSH_HOME` > `~/.dsh`（与 dsh-home-paths 同一优先级）。 */
export declare function resolveDshHome(configured?: string): string;
export declare function resolvePaths(config: MemoryConfig): MemoryPaths;
export declare function ensureDirs(paths: MemoryPaths): Promise<void>;
/** 原子写：临时文件 + rename；失败不留下半写文件。 */
export declare function writeFileAtomic(path: string, content: string): Promise<void>;
export declare function readTextIfExists(path: string): Promise<string | undefined>;
export declare function readFacts(paths: MemoryPaths): Promise<FactRecord[]>;
export declare function factToYaml(record: FactRecord): YamlValue;
export declare function writeFacts(paths: MemoryPaths, facts: readonly FactRecord[]): Promise<void>;
/** 派发新 id：`mem-<时间戳><序号>`（可读、稳定、不依赖随机数）。 */
export declare function nextFactId(now?: Date): string;
export interface UpsertResult {
    fact: FactRecord;
    action: 'created' | 'versioned' | 'unchanged';
}
/**
 * 追加式写入：同 id 且最新版本值相同 → unchanged（不写）；
 * 值不同 → 追加 history 版本（旧的永不删）。找不到 id 时按 fact 文本匹配同名事实。
 */
export declare function upsertFact(facts: FactRecord[], input: {
    id?: string;
    fact: string;
    value: string;
    date: string;
    source?: string[];
    tags?: string[];
    note?: string;
}): UpsertResult;
export declare function readCandidates(paths: MemoryPaths): Promise<CandidateRecord[]>;
export declare function candidateToYaml(record: CandidateRecord): YamlValue;
export declare function writeCandidates(paths: MemoryPaths, records: readonly CandidateRecord[]): Promise<void>;
export declare function nextCandidateId(now?: Date): string;
/** 记录一条候选：同条目（fact 去空白后相同）重复出现 → count+1、刷新 last_seen。 */
export declare function addCandidate(records: CandidateRecord[], input: {
    fact: string;
    date: string;
    source?: string[];
    tags?: string[];
    note?: string;
}): CandidateRecord;
export declare function readBrief(paths: MemoryPaths): Promise<string | undefined>;
/** 生成新的摘要正文（当前态）。旧版由 archiveBrief() 归档到 log/，内容不丢。 */
export declare function composeBrief(today: string, body: string): string;
/** 归档旧摘要到 log/brief-<日期>.md（只追加不删：旧内容以文件形式保留）。 */
export declare function archiveBrief(paths: MemoryPaths, date: string, previous: string): Promise<string>;
export declare function writeBrief(paths: MemoryPaths, content: string): Promise<void>;
export declare function appendLog(paths: MemoryPaths, date: string, entry: Record<string, YamlValue | undefined>): Promise<void>;
export declare function readLog(paths: MemoryPaths, date: string): Promise<Array<Record<string, YamlValue>>>;
export declare function readSeenSessions(paths: MemoryPaths): Promise<string[]>;
export declare function writeSeenSessions(paths: MemoryPaths, ids: readonly string[]): Promise<void>;
