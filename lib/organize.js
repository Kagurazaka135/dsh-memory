import { chat, extractJsonObject } from "./llm.js";
import { digestSession, listRecentSessions } from "./session-scan.js";
import { addCandidate, appendLog, archiveBrief, composeBrief, ensureDirs, readBrief, readCandidates, readFacts, readSeenSessions, resolvePaths, upsertFact, writeBrief, writeCandidates, writeFacts, writeSeenSessions, } from "./store.js";
export function localDate(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
const MAX_FACT_OPS = 20;
const MAX_CANDIDATE_OPS = 20;
const MAX_DIGEST_CHARS = 60_000;
export async function runOrganize(options) {
    const { config, sessionQuery, signal, dryRun } = options;
    const paths = resolvePaths(config);
    const date = localDate();
    const logPath = `${paths.logDir}/${date}.json`;
    const notes = [];
    const result = {
        ok: false, date, sessionsScanned: 0, factsCreated: [], factsVersioned: [],
        candidatesAdded: 0, briefUpdated: false, logPath, notes,
    };
    await ensureDirs(paths);
    const [facts, candidates, brief, seen] = await Promise.all([
        readFacts(paths).catch(() => []),
        readCandidates(paths).catch(() => []),
        readBrief(paths).catch(() => undefined),
        readSeenSessions(paths).catch(() => []),
    ]);
    // ---- 1. 扫会话 ----
    const scanLimit = Math.max(1, Math.min(config.scan_sessions ?? 12, 40));
    const skipId = options.skipSessionId?.trim() || config.organizer_session?.trim() || 'memory-organizer';
    const digests = [];
    const seenNow = [];
    if (sessionQuery !== undefined) {
        try {
            const records = await listRecentSessions(sessionQuery, { days: 2, limit: scanLimit, ...(signal ? { signal } : {}) });
            for (const record of records) {
                if (record.header.id === skipId)
                    continue;
                if (record.header.origin === 'subagent')
                    continue;
                const digest = await digestSession(sessionQuery, record.header.id, signal ? { signal } : {});
                if (digest === undefined)
                    continue;
                digests.push({ id: digest.id, text: digest.lines.join('\n') });
                seenNow.push(digest.id);
            }
        }
        catch (error) {
            notes.push(`会话扫描失败（继续整理已有记忆）：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    else {
        notes.push('宿主未提供 sessionQuery 服务：本次整理只看 L2 候选，不扫会话');
    }
    result.sessionsScanned = digests.length;
    // ---- 2. 走 broker 归纳 ----
    const pendingCandidates = candidates.filter(item => item.status === 'pending');
    const prompt = buildPrompt({
        date,
        facts: facts.map(item => ({ id: item.id, fact: item.fact, value: item.history.at(-1)?.value ?? '', since: item.since })),
        candidates: pendingCandidates.map(item => ({ fact: item.fact, count: item.count })),
        digests,
        brief: brief ?? '',
    });
    const totalDigest = digests.reduce((sum, item) => sum + item.text.length, 0);
    if (totalDigest > MAX_DIGEST_CHARS) {
        notes.push(`会话内容较长（${totalDigest} 字），已按会话截断喂给模型`);
    }
    let output;
    try {
        output = await callOrganizer(config, prompt, signal);
    }
    catch (error) {
        // 上游偶发（空 content / 超时）重试一次；仍失败才放弃 —— 宁可不写，不编造。
        try {
            output = await callOrganizer(config, prompt, signal);
        }
        catch (retryError) {
            const message = retryError instanceof Error ? retryError.message : String(retryError);
            result.error = message;
            await appendLog(paths, date, {
                action: 'organize', ok: false, error: message,
                sessions_scanned: result.sessionsScanned,
                note: '整理失败（已重试一次）：未写入任何事实/摘要（只追加铁律与"不编造"原则）',
            });
            return result;
        }
    }
    // ---- 3. 只追加地落地 ----
    const createdIds = [];
    const versionedIds = [];
    for (const proposal of output.facts.slice(0, MAX_FACT_OPS)) {
        if (!proposal.fact || !proposal.value)
            continue;
        const upserted = upsertFact(facts, {
            ...(proposal.id ? { id: proposal.id } : {}),
            fact: proposal.fact,
            value: proposal.value,
            date,
            source: proposal.source,
            tags: proposal.tags,
            ...(proposal.note ? { note: proposal.note } : {}),
        });
        if (upserted.action === 'created')
            createdIds.push(upserted.fact.id);
        else if (upserted.action === 'versioned')
            versionedIds.push(upserted.fact.id);
    }
    let candidatesAdded = 0;
    for (const proposal of output.candidates.slice(0, MAX_CANDIDATE_OPS)) {
        if (!proposal.fact)
            continue;
        const before = candidates.length;
        const record = addCandidate(candidates, { fact: proposal.fact, date, source: proposal.source, tags: proposal.tags });
        if (record.count === 1 && candidates.length > before)
            candidatesAdded += 1;
    }
    let briefUpdated = false;
    if (!dryRun) {
        if (createdIds.length > 0 || versionedIds.length > 0)
            await writeFacts(paths, facts);
        if (output.candidates.length > 0)
            await writeCandidates(paths, candidates);
        const briefBody = output.brief?.trim();
        if (briefBody !== undefined && briefBody !== '') {
            const next = composeBrief(date, briefBody);
            if (next !== brief) {
                if (brief !== undefined)
                    await archiveBrief(paths, date, brief);
                await writeBrief(paths, next);
                briefUpdated = true;
            }
        }
        await writeSeenSessions(paths, [...seen, ...seenNow]);
        await appendLog(paths, date, {
            action: 'organize', ok: true,
            model: config.organizer_model ?? 'deepseek-flash',
            sessions_scanned: result.sessionsScanned,
            sessions: seenNow,
            facts: [
                ...createdIds.map(id => ({ id, op: 'created' })),
                ...versionedIds.map(id => ({ id, op: 'versioned' })),
            ],
            candidates_added: candidatesAdded,
            brief_updated: briefUpdated,
            summary: output.summary ?? '',
        });
    }
    else {
        notes.push('dry_run：不落盘');
        briefUpdated = output.brief !== undefined && output.brief.trim() !== '';
    }
    result.ok = true;
    result.factsCreated = createdIds;
    result.factsVersioned = versionedIds;
    result.candidatesAdded = candidatesAdded;
    result.briefUpdated = briefUpdated;
    result.summary = output.summary;
    return result;
}
/** 调一次整理模型（broker）并解析输出。 */
async function callOrganizer(config, prompt, signal) {
    const raw = await chat({ baseUrl: config.broker_url ?? 'http://127.0.0.1:9999', model: config.organizer_model ?? 'deepseek-flash' }, [{ role: 'user', content: prompt }], signal);
    return parseOrganizerOutput(raw);
}
function buildPrompt(input) {
    const factsBlock = input.facts.length === 0
        ? '（空）'
        : input.facts.map(item => `- [${item.id}] ${item.fact} = ${item.value}（since ${item.since}）`).join('\n');
    const candidatesBlock = input.candidates.length === 0
        ? '（空）'
        : input.candidates.map(item => `- ${item.fact}（出现 ${item.count} 次）`).join('\n');
    const sessionsBlock = input.digests.length === 0
        ? '（今天没有可扫描的会话）'
        : input.digests.map(item => `### 会话 ${item.id}\n${item.text}`).join('\n\n');
    const briefBlock = input.brief.trim() === '' ? '（还没有摘要）' : input.brief.trim();
    return `你是"记忆整理器"。今天是 ${input.date}。你要从今天的会话里提炼**稳定、以后还用得上**的事实与进展，输出严格 JSON。

## 现有 L3 事实（版本化，只能追加新版本，不能改写历史）
${factsBlock}

## 现有 L2 待升格候选
${candidatesBlock}

## 当前 L4 启动摘要
${briefBlock}

## 今天的会话摘录
${sessionsBlock}

## 任务
1. facts：只收录**长期有效的稳定事实**（用户偏好/配置/约定/项目状态/重要结论）。规则：
   - 与现有事实同主题但值变了 → 给 \`"id"\` 表示给该条追加新版本（保留旧版）；
   - 全新事实 → 不给 id，我会自动编号；
   - 与现有事实**值相同** → 不要输出（我会判重）；
   - 拿不准是否长期有效 → 放进 candidates 而不是 facts。
2. candidates：值得跟踪但还没定论的线索（反复出现的话题、待办倾向、可能成为事实的苗头）。
3. brief：更新后的 L4 启动摘要（中文 Markdown，≤120 行）：当前在做什么/关键事实/进度/下一步。
   没有实质变化就原样返回旧摘要。
4. summary：一句话说明本次整理做了什么。

## 输出格式（只输出 JSON，不要解释）
{
  "facts": [{ "id": "可选，已有事实的 id", "fact": "主题（短）", "value": "当前值", "source": ["会话id"], "tags": ["标签"], "note": "可选，为什么" }],
  "candidates": [{ "fact": "线索", "source": ["会话id"], "tags": [] }],
  "brief": "# Markdown 摘要正文",
  "summary": "一句话"
}`;
}
/** 解析模型输出；非法输出抛错（宁可不写）。 */
export function parseOrganizerOutput(raw) {
    const parsed = extractJsonObject(raw);
    if (parsed === undefined) {
        throw new Error(`dsh-memory: 整理模型输出不是可解析的 JSON（前 200 字：${raw.slice(0, 200)}）`);
    }
    const facts = [];
    const rawFacts = parsed.facts;
    if (Array.isArray(rawFacts)) {
        for (const item of rawFacts) {
            if (item === null || typeof item !== 'object')
                continue;
            const record = item;
            const fact = typeof record.fact === 'string' ? record.fact.trim() : '';
            const value = typeof record.value === 'string' ? record.value.trim() : '';
            if (fact === '' || value === '')
                continue;
            facts.push({
                ...(typeof record.id === 'string' && record.id.trim() !== '' ? { id: record.id.trim() } : {}),
                fact,
                value,
                source: stringArray(record.source),
                tags: stringArray(record.tags),
                ...(typeof record.note === 'string' && record.note.trim() !== '' ? { note: record.note.trim() } : {}),
            });
        }
    }
    const candidates = [];
    const rawCandidates = parsed.candidates;
    if (Array.isArray(rawCandidates)) {
        for (const item of rawCandidates) {
            if (item === null || typeof item !== 'object')
                continue;
            const record = item;
            const fact = typeof record.fact === 'string' ? record.fact.trim() : '';
            if (fact === '')
                continue;
            candidates.push({ fact, source: stringArray(record.source), tags: stringArray(record.tags) });
        }
    }
    return {
        facts,
        candidates,
        ...(typeof parsed.brief === 'string' ? { brief: parsed.brief } : {}),
        ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
    };
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.trim() !== '').map(item => item.trim());
}
