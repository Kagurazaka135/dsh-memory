/**
 * 存储层 —— `$DSH_HOME/memory/`：
 *
 *   brief.md            L4 启动摘要（人可读 Markdown）
 *   facts.yaml          L3 永久事实（版本化，只追加 history）
 *   candidates.yaml     L2 待升格候选
 *   log/YYYY-MM-DD.json 夜间整理记录（append-only NDJSON 日记）
 *   .sessions.json      已内部化处理的会话 id（避免重复归纳）
 *
 * 铁律：**只追加不删** —— 本文件没有任何删除/覆盖历史条目的路径。
 * 唯一允许“覆盖”的是 brief.md 与 candidates.yaml 的当前态（二者可由 facts + 会话重建，
 * 且候选被升格/驳回时带 `status` 标记保留在文件里，不物理删除）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseYaml, toYaml } from "./yaml.js";
/** DSH_HOME 解析：配置 > `$DSH_HOME` > `~/.dsh`（与 dsh-home-paths 同一优先级）。 */
export function resolveDshHome(configured) {
    const configuredText = configured?.trim();
    if (configuredText)
        return configuredText;
    const envText = process.env.DSH_HOME?.trim();
    if (envText)
        return envText;
    return join(homedir(), '.dsh');
}
export function resolvePaths(config) {
    const root = config.memory_dir?.trim() || join(resolveDshHome(), 'memory');
    return {
        root,
        brief: join(root, 'brief.md'),
        facts: join(root, 'facts.yaml'),
        candidates: join(root, 'candidates.yaml'),
        logDir: join(root, 'log'),
        seen: join(root, '.sessions.json'),
    };
}
export async function ensureDirs(paths) {
    await mkdir(paths.logDir, { recursive: true });
}
/** 原子写：临时文件 + rename；失败不留下半写文件。 */
export async function writeFileAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
}
export async function readTextIfExists(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
// ---------- 事实（L3） ----------
const FACTS_HEADER = [
    'dsh-memory · L3 永久事实（版本化，只追加）',
    '由 memory_note / memory_promote / 夜间整理维护；history 是版本链，最新一条 = 当前值。',
    '请勿手写覆盖历史条目 —— 修改事实请用 memory_note（自动追加新版本）。',
];
export async function readFacts(paths) {
    const text = await readTextIfExists(paths.facts);
    if (text === undefined || text.trim() === '')
        return [];
    const parsed = parseYaml(text);
    if (parsed === null)
        return [];
    if (!Array.isArray(parsed))
        throw new Error('dsh-memory: facts.yaml 顶层应为数组（受限 YAML）');
    return parsed.filter(isRecord).map(coerceFact);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string');
}
function coerceFact(raw) {
    const history = Array.isArray(raw.history)
        ? raw.history.filter(isRecord).map(entry => ({
            date: asString(entry.date),
            value: asString(entry.value),
            ...(typeof entry.note === 'string' && entry.note ? { note: entry.note } : {}),
        })).filter(entry => entry.value !== '')
        : [];
    const latest = history.at(-1);
    return {
        id: asString(raw.id),
        fact: asString(raw.fact),
        since: asString(raw.since, latest?.date ?? ''),
        history,
        source: asStringArray(raw.source),
        tags: asStringArray(raw.tags),
        updated_at: asString(raw.updated_at, latest?.date ?? ''),
    };
}
export function factToYaml(record) {
    return {
        id: record.id,
        fact: record.fact,
        since: record.since,
        history: record.history.map(version => ({
            date: version.date,
            value: version.value,
            ...(version.note ? { note: version.note } : {}),
        })),
        source: record.source,
        tags: record.tags,
        updated_at: record.updated_at,
    };
}
export async function writeFacts(paths, facts) {
    await writeFileAtomic(paths.facts, toYaml(facts.map(factToYaml), FACTS_HEADER));
}
let factCounter = 0;
/** 派发新 id：`mem-<时间戳><序号>`（可读、稳定、不依赖随机数）。 */
export function nextFactId(now = new Date()) {
    factCounter = (factCounter + 1) % 1000;
    const pad = String(now.getTime()).padStart(13, '0');
    return `mem-${pad}-${String(factCounter).padStart(3, '0')}`;
}
/**
 * 追加式写入：同 id 且最新版本值相同 → unchanged（不写）；
 * 值不同 → 追加 history 版本（旧的永不删）。找不到 id 时按 fact 文本匹配同名事实。
 */
export function upsertFact(facts, input) {
    const normalized = normalizeText(input.value);
    // 命中顺序：先按 id（同一事实的稳定身份），再按 fact 文本（去空白相等即同一主题）——
    // 二者都没有才是新事实。这样"改一条事实"永远落到同一条目上、只追加版本。
    let target;
    if (input.id)
        target = facts.find(item => item.id === input.id);
    if (target === undefined)
        target = facts.find(item => normalizeText(item.fact) === normalizeText(input.fact));
    if (target === undefined) {
        const version = { date: input.date, value: input.value, ...(input.note ? { note: input.note } : {}) };
        const created = {
            id: input.id ?? nextFactId(),
            fact: input.fact,
            since: input.date,
            history: [version],
            source: input.source ?? [],
            tags: input.tags ?? [],
            updated_at: input.date,
        };
        facts.push(created);
        return { fact: created, action: 'created' };
    }
    const latest = target.history.at(-1);
    const sameValue = latest !== undefined && normalizeText(latest.value) === normalized;
    if (sameValue) {
        // 值没变：只合并来源/标签（去重、只增不减），不算新版本
        target.source = mergeUnique(target.source, input.source ?? []);
        target.tags = mergeUnique(target.tags, input.tags ?? []);
        return { fact: target, action: 'unchanged' };
    }
    target.history.push({ date: input.date, value: input.value, ...(input.note ? { note: input.note } : {}) });
    target.source = mergeUnique(target.source, input.source ?? []);
    target.tags = mergeUnique(target.tags, input.tags ?? []);
    target.updated_at = input.date;
    if (input.fact && input.fact !== target.fact)
        target.fact = input.fact;
    return { fact: target, action: 'versioned' };
}
function normalizeText(value) {
    return value.trim().replace(/\s+/g, ' ');
}
function mergeUnique(base, added) {
    const out = [...base];
    for (const item of added)
        if (!out.includes(item))
            out.push(item);
    return out;
}
// ---------- 候选（L2） ----------
const CANDIDATES_HEADER = [
    'dsh-memory · L2 待升格候选（只追加，升格/驳回只改 status 不删除）',
    'status: pending 待人工确认 | promoted 已升格 | rejected 已驳回（仍保留可见）',
];
export async function readCandidates(paths) {
    const text = await readTextIfExists(paths.candidates);
    if (text === undefined || text.trim() === '')
        return [];
    const parsed = parseYaml(text);
    if (parsed === null)
        return [];
    if (!Array.isArray(parsed))
        throw new Error('dsh-memory: candidates.yaml 顶层应为数组（受限 YAML）');
    return parsed.filter(isRecord).map((raw) => {
        const statusText = asString(raw.status, 'pending');
        const status = statusText === 'promoted' || statusText === 'rejected' ? statusText : 'pending';
        return {
            id: asString(raw.id),
            fact: asString(raw.fact),
            first_seen: asString(raw.first_seen),
            last_seen: asString(raw.last_seen),
            count: typeof raw.count === 'number' ? raw.count : 1,
            source: asStringArray(raw.source),
            tags: asStringArray(raw.tags),
            status,
            ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
        };
    }).filter(item => item.id !== '' && item.fact !== '');
}
export function candidateToYaml(record) {
    return {
        id: record.id,
        fact: record.fact,
        first_seen: record.first_seen,
        last_seen: record.last_seen,
        count: record.count,
        source: record.source,
        tags: record.tags,
        status: record.status,
        ...(record.note ? { note: record.note } : {}),
    };
}
export async function writeCandidates(paths, records) {
    await writeFileAtomic(paths.candidates, toYaml(records.map(candidateToYaml), CANDIDATES_HEADER));
}
let candidateCounter = 0;
export function nextCandidateId(now = new Date()) {
    candidateCounter = (candidateCounter + 1) % 1000;
    return `cand-${String(now.getTime()).padStart(13, '0')}-${String(candidateCounter).padStart(3, '0')}`;
}
/** 记录一条候选：同条目（fact 去空白后相同）重复出现 → count+1、刷新 last_seen。 */
export function addCandidate(records, input) {
    const normalized = normalizeText(input.fact);
    const existing = records.find(item => normalizeText(item.fact) === normalized);
    if (existing !== undefined) {
        existing.count += 1;
        existing.last_seen = input.date;
        existing.source = mergeUnique(existing.source, input.source ?? []);
        existing.tags = mergeUnique(existing.tags, input.tags ?? []);
        if (input.note)
            existing.note = input.note;
        return existing;
    }
    const created = {
        id: nextCandidateId(),
        fact: input.fact,
        first_seen: input.date,
        last_seen: input.date,
        count: 1,
        source: input.source ?? [],
        tags: input.tags ?? [],
        status: 'pending',
        ...(input.note ? { note: input.note } : {}),
    };
    records.push(created);
    return created;
}
// ---------- 摘要（L4） ----------
const BRIEF_HEADER = [
    'dsh-memory · L4 启动摘要（O(1) 读；丢了可由 facts.yaml + 会话重建）',
    '由夜间整理 / memory_organize 更新。',
];
export async function readBrief(paths) {
    const text = await readTextIfExists(paths.brief);
    return text === undefined || text.trim() === '' ? undefined : text;
}
/** 生成新的摘要正文（当前态）。旧版由 archiveBrief() 归档到 log/，内容不丢。 */
export function composeBrief(today, body) {
    const lines = [
        ...BRIEF_HEADER.map(line => `<!-- ${line} -->`),
        '',
        `<!-- 摘要更新于 ${today} -->`,
        '',
        body.trim(),
        '',
    ];
    return lines.join('\n');
}
/** 归档旧摘要到 log/brief-<日期>.md（只追加不删：旧内容以文件形式保留）。 */
export async function archiveBrief(paths, date, previous) {
    await ensureDirs(paths);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(paths.logDir, `brief-${date}-${stamp}.md`);
    await writeFileAtomic(path, previous);
    return path;
}
export async function writeBrief(paths, content) {
    await writeFileAtomic(paths.brief, content);
}
// ---------- 整理日志（append-only NDJSON） ----------
export async function appendLog(paths, date, entry) {
    await ensureDirs(paths);
    const path = join(paths.logDir, `${date}.json`);
    const line = JSON.stringify({ time: new Date().toISOString(), ...dropUndefined(entry) });
    const existing = (await readTextIfExists(path)) ?? '';
    await writeFileAtomic(path, `${existing}${line}\n`);
}
function dropUndefined(input) {
    const out = {};
    for (const [key, value] of Object.entries(input))
        if (value !== undefined)
            out[key] = value;
    return out;
}
export async function readLog(paths, date) {
    const text = await readTextIfExists(join(paths.logDir, `${date}.json`));
    if (text === undefined)
        return [];
    const out = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isRecord(parsed))
                out.push(parsed);
        }
        catch {
            /* 坏行跳过（只读路径不修文件） */
        }
    }
    return out;
}
// ---------- 已处理会话台账 ----------
export async function readSeenSessions(paths) {
    const text = await readTextIfExists(paths.seen);
    if (text === undefined)
        return [];
    try {
        const parsed = JSON.parse(text);
        if (isRecord(parsed) && Array.isArray(parsed.ids)) {
            return parsed.ids.filter((item) => typeof item === 'string');
        }
    }
    catch {
        /* 损坏就当作空台账（下次整理重新记账；不会删任何记忆内容） */
    }
    return [];
}
export async function writeSeenSessions(paths, ids) {
    const unique = [...new Set(ids)];
    await writeFileAtomic(paths.seen, `${JSON.stringify({ ids: unique.slice(-500) }, null, 2)}\n`);
}
