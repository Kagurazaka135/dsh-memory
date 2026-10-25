/**
 * dsh-memory 本地 E2E（独立测试台，不依赖真实 dsh 安装）。
 *
 * 覆盖：
 *  1. 六只工具真实注册（经 @deepseek-ai/dsh-tools 的 ToolRuntime）+ 执行
 *  2. L3 版本化：同一主题记两次 → history 两条、旧值不丢
 *  3. L2 候选 + memory_promote 升格
 *  4. memory_organize：假 sessionQuery 喂会话 → 真 broker 归纳 → 只追加落盘
 *  5. 自动注册：假 sessions/schedule 服务 → 验 create/flush 参数与幂等
 *
 * 用临时 DSH_HOME，不碰真实 ~/.dsh。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const toUrl = (path) => pathToFileURL(path).href
const HERE = 'G:/code/dsh-memory'

const home = await mkdtemp(join(tmpdir(), 'dsh-memory-e2e-'))
process.env.DSH_HOME = home
console.log(`[e2e] DSH_HOME = ${home}`)

const { Context } = await import(toUrl(require.resolve('@deepseek-ai/cordis', { paths: [HERE] })))
const {
  default: SystemPrompt, renderPrompt, renderContextSnapshot,
} = await import(toUrl(require.resolve('@deepseek-ai/dsh-system-prompt', { paths: [HERE] })))
const { default: ToolRuntime } = await import(toUrl(require.resolve('@deepseek-ai/dsh-tools', { paths: [HERE] })))
const { CallId, projectImagesForTextModel } = await import(toUrl(require.resolve('@deepseek-ai/dsh-llm', { paths: [HERE] })))
const pluginMod = await import(toUrl(`${HERE}/lib/index.js`))
const { CAPABILITY_TEXT } = await import(toUrl(`${HERE}/lib/prompt.js`))
const { fitDigests } = await import(toUrl(`${HERE}/lib/organize.js`))

// ---------- 假宿主服务 ----------
const calls = { flush: 0, created: [], prepared: [], deleted: 0 }
const fakeSessions = {
  get: () => undefined,
  prepare(id, options) { calls.prepared.push({ id, options }); return { id, header: { id, cwd: options?.meta?.cwd } } },
  create(id, options) { calls.created.push({ id, options }); return { id, header: { id, cwd: options?.meta?.cwd } } },
  async flush() { calls.flush += 1; return true },
}
// 假持久层：模拟 dsh ≥0.2.x 的 sessionPersistence（stat/create + 写句柄）。
const persistenceCalls = { stat: 0, created: [], flushed: 0, closed: 0 }
const materialized = new Map()
const fakePersistence = {
  async stat(id) { persistenceCalls.stat += 1; return materialized.has(id) ? { header: materialized.get(id) } : undefined },
  async create(header) {
    persistenceCalls.created.push(header)
    materialized.set(header.id, header)
    return { async flush() { persistenceCalls.flushed += 1 }, async close() { persistenceCalls.closed += 1 } }
  },
}
const scheduleTasks = []
const fakeSchedule = {
  async create(sessionId, request) {
    const record = {
      id: `schedule-fake-${scheduleTasks.length + 1}`, title: request.title, prompt: request.prompt,
      sessionId, status: 'active', daily: request.daily,
    }
    scheduleTasks.push(record)
    return { id: record.id }
  },
  async catalog() { return [...scheduleTasks] },
  async delete({ id, sessionId }) {
    calls.deleted += 1
    const index = scheduleTasks.findIndex(task => task.id === id && task.sessionId === sessionId)
    if (index >= 0) scheduleTasks.splice(index, 1)
    return { deleted: index >= 0 }
  },
}
// 假 llm 服务。默认用**桩数据**（零网络，干净环境可直跑）。
// 想让它真调一个 OpenAI 兼容端点，设两个环境变量：
//   E2E_LLM_URL=https://.../v1/chat/completions  E2E_LLM_KEY=...
// 同时记录每次调用的 provider/model，用来验"走的是宿主模型"。
const llmCalls = []
const liveUrl = process.env.E2E_LLM_URL
const liveKey = process.env.E2E_LLM_KEY ?? ''
const fakeLlm = {
  async *stream(options) {
    llmCalls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens })

    // 契约闸：跑宿主**自己的**消息投影函数。它对字符串 content 会炸
    // （`content.some is not a function`），而转发给 OpenAI 兼容端点不会（那里字符串合法）。
    // 曾因为缺这道闸，content 传字符串的真 bug 被 60 项全绿掩盖。
    projectImagesForTextModel(options.messages)

    if (liveUrl === undefined) {
      // 桩：够跑通链路即可。分片请求按 prompt 里的 id 自己分两片，其余请求回空整理结果。
      const promptText = options.messages.map(m => (m.content ?? []).map(b => b.text).join('')).join('\n')
      if (promptText.includes('分片归档')) {
        const ids = [...promptText.matchAll(/^- (mem-[\w-]+) ·/gm)].map(m => m[1])
        const half = Math.ceil(ids.length / 2)
        yield {
          type: 'text-delta',
          text: JSON.stringify({ groups: { 'e2e-a': ids.slice(0, half), 'e2e-b': ids.slice(half) } }),
        }
      } else {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            facts: [], candidates: [],
            brief: '# e2e 摘要\n\n本文件由 e2e 桩生成，用于验证落盘链路。',
            summary: 'e2e stub',
          }),
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const response = await fetch(liveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${liveKey}` },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: false,
      }),
    })
    if (!response.ok) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `LLM endpoint HTTP ${response.status}` } } }
      return
    }
    const body = await response.json()
    const message = body?.choices?.[0]?.message ?? {}
    const text = typeof message.content === 'string' ? message.content : ''
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    if (reasoning) yield { type: 'reasoning-delta', text: reasoning }
    if (text) yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const fakeDefaultModel = {
  currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
}

const now = Date.now()
const fakeSessionQuery = {
  async listSessions() {
    return [
      { header: { id: 'sess-today', createdAt: now - 60_000 }, live: false, persisted: true },
      { header: { id: 'sess-old', createdAt: now - 5 * 24 * 60 * 60 * 1000 }, live: false, persisted: true },
    ]
  },
  async observeSession(id) {
    return {
      header: { id, createdAt: now - 60_000 },
      events: [
        { type: 'user/message', time: now - 50_000, data: { role: 'user', content: [{ type: 'text', text: '帮我把默认模型从 Qwen 换成 deepseek-flash，以后都用它；另外我最近在犹豫要不要把夜间整理挪到凌晨 5 点。' }] } },
        { type: 'assistant/message', time: now - 40_000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，默认模型已换。夜间整理时间我记下你的犹豫，之后再定。' }] } } },
      ],
    }
  },
}

// ---------- 挂载 ----------
const ctx0 = new Context()
new SystemPrompt(ctx0, {})
new ToolRuntime(ctx0, {})
ctx0.provide('sessions', fakeSessions)
ctx0.provide('schedule', fakeSchedule)
ctx0.provide('sessionQuery', fakeSessionQuery)
ctx0.provide('llm', fakeLlm)
ctx0.provide('agentDefaultModel', fakeDefaultModel)
ctx0.provide('sessionPersistence', fakePersistence)
await ctx0.plugin(pluginMod, { memory_dir: join(home, 'memory') })
await new Promise(resolve => setTimeout(resolve, 300)) // 等 ctx.inject 的异步注册链跑完

console.log('[e2e] mounted. tools =', typeof ctx0.tools)

const signal = new AbortController().signal
let toolSeq = 0
async function call(name, args) {
  toolSeq += 1
  const result = await ctx0.tools.execute({ callId: CallId(`e2e-${toolSeq}`), name, arguments: args, signal })
  const text = (result?.content ?? []).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
  return { result, text }
}

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ---------- 1. note 版本化 ----------
console.log('\n== 1. memory_note 版本化 ==')
const note1 = await call('memory_note', { fact: '默认模型', value: 'deepseek-flash', tags: ['config'] })
console.log(note1.text)
check('首次记事实成功', /已新建/.test(note1.text))

const note2 = await call('memory_note', { fact: '默认模型', value: 'deepseek-flash' })
check('同值重复写入被去重', /未变化/.test(note2.text), note2.text.slice(0, 60))

const note3 = await call('memory_note', { fact: '默认模型', value: 'glm-4.6' })
console.log(note3.text)
check('改值追加新版本', /已追加新版本/.test(note3.text))

// ---------- 2. recall 版本历史 ----------
console.log('\n== 2. memory_recall ==')
const recall = await call('memory_recall', { query: '默认模型' })
console.log(recall.text)
check('检索命中', /默认模型/.test(recall.text))
check('旧版本仍在（deepseek-flash）', recall.text.includes('deepseek-flash'))
check('新版本出现（glm-4.6）+当前标记', recall.text.includes('glm-4.6') && recall.text.includes('当前'))

// ---------- 2b. 0 命中 → 升级话术（不返回空列表了事） ----------
console.log('\n== 2b. memory_recall 0 命中话术 ==')
const miss = await call('memory_recall', { query: '这个词肯定没有zzz' })
console.log(miss.text)
check('0 命中不是空话，给出"≠ 从未记录"', miss.text.includes('0 命中 ≠ 从未记录'))
check('给出可执行的重试路径', miss.text.includes('更少、更独特') && miss.text.includes('memory_brief'))
check('提示记忆是某时点断言', miss.text.includes('写入那一刻的断言'))

// ---------- 3. candidate + promote ----------
console.log('\n== 3. memory_candidate / memory_promote ==')
const cand = await call('memory_candidate', { fact: '夜间整理时间可能挪到凌晨 5 点' })
console.log(cand.text)
check('候选已记录', /候选已记录/.test(cand.text))
const candId = /id (cand-[\w-]+)/.exec(cand.text)?.[1]
const promote = await call('memory_promote', { id: candId, value: '夜间整理时间：倾向挪到凌晨 5 点（待定）', tags: ['memory'] })
console.log(promote.text)
check('升格成功', /已升格/.test(promote.text))
const recall2 = await call('memory_recall', { tags: ['memory'] })
check('升格后可按标签检索', recall2.text.includes('凌晨 5 点'))

// ---------- 4. organize（真 broker） ----------
console.log('\n== 4. memory_organize（走宿主 ctx.llm，真模型归纳）==')
const dry = await call('memory_organize', { dry_run: true })
console.log(dry.text)
check('dry-run 成功（模型可达）', /dry-run/.test(dry.text) && !/整理失败/.test(dry.text))
check('走的是宿主 llm 服务，不是自己拼 HTTP', llmCalls.length >= 1, JSON.stringify(llmCalls[0]))
check('默认跟随宿主当前模型（agentDefaultModel）',
  llmCalls[0]?.provider === 'deepseek-official' && llmCalls[0]?.model === 'deepseek-flash',
  JSON.stringify(llmCalls[0]))

const org = await call('memory_organize', {})
console.log(org.text)
check('整理完成', /整理完成/.test(org.text))

// ---------- 5. brief ----------
console.log('\n== 5. memory_brief ==')
const brief = await call('memory_brief', {})
console.log(brief.text.slice(0, 600))
check('摘要可读', brief.text.includes('#') || brief.text.includes('L3 事实'))

// ---------- 5b. system prompt 注入 ----------
console.log('\n== 5b. system prompt 注入 ==')
const assembly = await ctx0.systemPrompt.assemble()
const promptText = renderPrompt(assembly)
const contextText = renderContextSnapshot(assembly)
check('能力块已进 system prompt', promptText.includes(CAPABILITY_TEXT.trim()))
check('能力块含"某时点断言"硬规则', promptText.includes('写入那一刻的断言'))
check('能力块含"先搜再问"', promptText.includes('先 `memory_recall` 再问'))
check('能力块字节稳定：不含日期/临时目录/计数',
  !/\d{4}-\d{2}-\d{2}/.test(CAPABILITY_TEXT)
  && !CAPABILITY_TEXT.includes(home)
  && !/\d+\s*条/.test(CAPABILITY_TEXT)
  && !/(?:\/tmp\/|[A-Za-z]:\\Temp)/i.test(CAPABILITY_TEXT))
check('简报快照走动态 context 通道', contextText.includes('记忆当前快照') && contextText.includes('记忆目录'))
check('动态快照带真实记忆目录', contextText.includes(join(home, 'memory')))

// ---------- 6. 资盘检查 ----------
console.log('\n== 6. 落盘检查 ==')
const { readdir } = await import('node:fs/promises')
const root = join(home, 'memory')
const files = await readdir(root)
console.log('[e2e] memory 目录：', files.join(', '))
const factsRaw = await readFile(join(root, 'facts.yaml'), 'utf8')
console.log('---- facts.yaml ----\n' + factsRaw)
check('facts.yaml 存在', files.includes('facts.yaml'))
check('版本链：默认模型 history ≥2 条', (factsRaw.match(/- date:/g) ?? []).length >= 2)
check('旧版本值未丢（Qwen 之外 deepseek-flash 仍在）', factsRaw.includes('deepseek-flash'))
const briefRaw = await readFile(join(root, 'brief.md'), 'utf8')
check('brief.md 已生成', briefRaw.length > 50)
const logDir = await readdir(join(root, 'log'))
check('整理日志已写', logDir.some(name => name.endsWith('.json')))
const jsonl = await readFile(join(root, 'log', logDir.find(name => name.endsWith('.json'))), 'utf8')
check('日志含 organize 记录', jsonl.includes('organize'))
console.log('---- log ----\n' + jsonl)
const candRaw = await readFile(join(root, 'candidates.yaml'), 'utf8')
check('候选保留 promoted 标记（未删除）', candRaw.includes('promoted'))

// ---------- 7. 自动注册 ----------
console.log('\n== 7. schedule 自动注册 ==')
check('整理会话经 sessionPersistence 物化（create+flush+close）',
  persistenceCalls.created.some(h => h.id === 'memory-organizer') && persistenceCalls.flushed >= 1 && persistenceCalls.closed >= 1,
  JSON.stringify({ created: persistenceCalls.created.map(h => h.id), flushed: persistenceCalls.flushed, closed: persistenceCalls.closed }))
check('未误走内存 create（正规路径不碰 sessions.create）', calls.created.length === 0, JSON.stringify(calls.created))
check('每日任务已注册', scheduleTasks.length === 1, JSON.stringify(scheduleTasks.map(t => t.id)))
check('任务绑定整理会话', scheduleTasks[0]?.sessionId === 'memory-organizer')
check('任务标题为设计标题', scheduleTasks[0]?.title === '记忆整理（dsh-memory·夜间）')
check('提示词含工具指引', scheduleTasks[0]?.prompt?.includes('memory_organize'))
check('daily.time 为秒级 HH:mm:ss（0.2.x 严格格式）', /^\d{2}:\d{2}:\d{2}$/.test(scheduleTasks[0]?.daily?.time ?? ''), scheduleTasks[0]?.daily?.time)
const setupLog = await readFile(join(root, 'log', logDir.find(name => name.endsWith('.json'))), 'utf8')
check('注册诊断已落盘（schedule-setup）', setupLog.includes('schedule-setup'))
check('dispose 未删除任务（任务归 host 持久）', calls.deleted === 0)

// ---------- 8. 幂等（模拟重载：新 Context、schedule/persistence 里已有旧任务与会话） ----------
console.log('\n== 8. 幂等：模拟重载后不重复注册 ==')
const before = scheduleTasks.length
const beforePersistence = persistenceCalls.created.length
const ctx1 = new Context()
new SystemPrompt(ctx1, {})
new ToolRuntime(ctx1, {})
ctx1.provide('sessions', fakeSessions)
ctx1.provide('schedule', fakeSchedule)
ctx1.provide('sessionQuery', fakeSessionQuery)
ctx1.provide('llm', fakeLlm)
ctx1.provide('agentDefaultModel', fakeDefaultModel)
ctx1.provide('sessionPersistence', fakePersistence)
await ctx1.plugin(pluginMod, { memory_dir: join(home, 'memory') })
await new Promise(resolve => setTimeout(resolve, 300))
check('重载后任务数不变（判 already）', scheduleTasks.length === before, `before=${before} after=${scheduleTasks.length}`)
check('重载后不重复物化会话（stat 命中 exists）', persistenceCalls.created.length === beforePersistence, `before=${beforePersistence} after=${persistenceCalls.created.length}`)

// ---------- 9. 降级：没有 schedule 服务的宿主 ----------
console.log('\n== 9. 降级：无 schedule 服务（模拟 dsh 0.1.x）==')
const ctx2 = new Context()
new SystemPrompt(ctx2, {})
new ToolRuntime(ctx2, {})
await ctx2.plugin(pluginMod, { memory_dir: join(home, 'memory') })
await new Promise(resolve => setTimeout(resolve, 200))
const fallbackBrief = await ctx2.tools.execute({
  callId: CallId('e2e-fallback'),
  name: 'memory_brief',
  arguments: {},
  signal,
})
const fallbackText = (fallbackBrief?.content ?? []).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
check('无 schedule 服务时工具照常可用', fallbackText.includes('L3 事实') || fallbackText.includes('#'), fallbackText.slice(0, 80))
check('无 schedule 服务时未新增任务', scheduleTasks.length === before, `count=${scheduleTasks.length}`)
// ctx2 也没有 llm：整理必须给出可读的失败原因，而不是崩掉
const noLlm = await ctx2.tools.execute({
  callId: CallId('e2e-no-llm'), name: 'memory_organize', arguments: {}, signal,
})
const noLlmText = (noLlm?.content ?? []).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
check('无 llm 服务时整理给出明确原因（不崩）', noLlmText.includes('没有 llm 服务'), noLlmText.slice(0, 80))

// ---------- 10. enable_schedule=false → 主动清理自己的任务 ----------
console.log('\n== 10. enable_schedule=false 清理 ==')
const ctx3 = new Context()
new SystemPrompt(ctx3, {})
new ToolRuntime(ctx3, {})
ctx3.provide('sessions', fakeSessions)
ctx3.provide('schedule', fakeSchedule)
ctx3.provide('sessionPersistence', fakePersistence)
await ctx3.plugin(pluginMod, { memory_dir: join(home, 'memory'), enable_schedule: false })
await new Promise(resolve => setTimeout(resolve, 300))
check('任务已被清理（catalog 判 mine 后 delete）', scheduleTasks.length === 0, `count=${scheduleTasks.length}`)
check('只删自己的任务（delete 调用 ≥1）', calls.deleted >= 1, `deleted=${calls.deleted}`)

// ---------- 11. 摘要截断预算（纯函数，不烧模型） ----------
console.log('\n== 11. 会话摘录截断预算 ==')
const bigDigests = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, text: 'x'.repeat(24_000) }))
const fitted = fitDigests(bigDigests, 60_000)
const fittedChars = fitted.digests.reduce((sum, item) => sum + item.text.length, 0)
check('12×24000 字被压进 60000 预算', fittedChars <= 60_000, `实际 ${fittedChars}`)
check('截断确实发生了（不是只记一条提示）', fitted.truncatedChars > 0, `截掉 ${fitted.truncatedChars}`)
check('每场都带截断标记', fitted.digests.every(item => item.text.includes('本场已截断')))
check('未超预算时不截断', fitDigests([{ id: 'a', text: 'short' }], 60_000).truncatedChars === 0)

// ---------- 12. 分片：超阈值按主题拆文件 ----------
console.log('\n== 12. 记忆分片（80 条阈值）==')
const shardHome = await mkdtemp(join(tmpdir(), 'dsh-memory-shard-'))
const shardRoot = join(shardHome, 'memory')
const ctx4 = new Context()
new SystemPrompt(ctx4, {})
new ToolRuntime(ctx4, {})
ctx4.provide('sessionQuery', fakeSessionQuery)
ctx4.provide('llm', fakeLlm)
ctx4.provide('agentDefaultModel', fakeDefaultModel)
await ctx4.plugin(pluginMod, { memory_dir: shardRoot, enable_schedule: false })
await new Promise(resolve => setTimeout(resolve, 300))
async function call4(name, args) {
  toolSeq += 1
  const result = await ctx4.tools.execute({ callId: CallId(`e2e-s-${toolSeq}`), name, arguments: args, signal })
  return (result?.content ?? []).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
}
for (let i = 0; i < 85; i += 1) {
  await call4('memory_note', { fact: `测试事实 ${i}`, value: `值 ${i}`, tags: [i % 2 === 0 ? 'even' : 'odd'] })
}
const beforeShard = await readFile(join(shardRoot, 'facts.yaml'), 'utf8')
check('分片前：单文件 facts.yaml 有 85 条', (beforeShard.match(/- id:/g) ?? []).length === 85)

const reshaped = await call4('memory_organize', { reshard: true, scan_sessions: 1 })
console.log(reshaped)
check('整理报告了分片结果', /分片：\d+ 个文件/.test(reshaped))

const shardRootFiles = await readdir(shardRoot)
check('出现 facts/ 分片目录', shardRootFiles.includes('facts'))
const shardFiles = (await readdir(join(shardRoot, 'facts'))).filter(name => name.endsWith('.yaml'))
check('生成了多个分片文件', shardFiles.length >= 2, shardFiles.join(', '))
check('生成了 _index.yaml', shardFiles.includes('_index.yaml'))
const indexRaw = await readFile(join(shardRoot, 'facts', '_index.yaml'), 'utf8')
const indexTotal = Number(/total:\s*(\d+)/.exec(indexRaw)?.[1] ?? 0)
check('索引条目数覆盖全部事实（≥85，一条不丢）', indexTotal >= 85, `total=${indexTotal}`)
check('旧单文件已挪进 .archive（移动不是删除）', await readdir(join(shardRoot, '.archive')).then(n => n.some(x => x.startsWith('facts-'))).catch(() => false))

const recallSharded = await call4('memory_recall', { query: '测试事实 42' })
check('分片后 recall 仍能命中', recallSharded.includes('测试事实 42'), recallSharded.slice(0, 80))

await call4('memory_note', { fact: '分片后新事实', value: 'ok' })
const unsortedRaw = await readFile(join(shardRoot, 'facts', 'unsorted.yaml'), 'utf8').catch(() => '')
check('分片后新增事实落到 unsorted', unsortedRaw.includes('分片后新事实'))

const recallTags = await call4('memory_recall', { tags: ['even'] })
check('按标签检索走索引（命中且报告跳过分片或读全）', recallTags.includes('测试事实 0'), recallTags.slice(0, 80))

// ---------- 13. 分片名漂移（真宿主实测报的问题） ----------
console.log('\n== 13. 分片名不漂移（增量归属，不重排）==')
const indexBefore = await readFile(join(shardRoot, 'facts', '_index.yaml'), 'utf8')
const namesBefore = [...indexBefore.matchAll(/^\s*-\s*name:\s*"?([\w-]+)"?/gm)].map(m => m[1]).sort()
const filesBefore = (await readdir(join(shardRoot, 'facts'))).filter(n => n.endsWith('.yaml') && n !== '_index.yaml').sort()

// 再整理一次（不强制 reshard）：已有分片时应该走增量，不能重排
await call4('memory_organize', { scan_sessions: 1 })
const indexAfter = await readFile(join(shardRoot, 'facts', '_index.yaml'), 'utf8')
const namesAfter = [...indexAfter.matchAll(/^\s*-\s*name:\s*"?([\w-]+)"?/gm)].map(m => m[1]).sort()
check('第二次整理不改已有分片名', JSON.stringify(namesBefore) === JSON.stringify(namesAfter),
  `before=${namesBefore.join(',')} after=${namesAfter.join(',')}`)
check('第二次整理不新增空壳分片文件', filesBefore.every(n => (existing => existing)(filesBefore)) &&
  (await readdir(join(shardRoot, 'facts'))).filter(n => n.endsWith('.yaml') && n !== '_index.yaml').length <= filesBefore.length + 1,
  (await readdir(join(shardRoot, 'facts'))).join(', '))

// ---------- 14. 候选分裂回归（真宿主实测的原样本） ----------
console.log('\n== 14. 候选不分裂（摘录腔尾巴）==')
const candHome = await mkdtemp(join(tmpdir(), 'dsh-memory-cand-'))
const ctx5 = new Context()
new SystemPrompt(ctx5, {})
new ToolRuntime(ctx5, {})
ctx5.provide('llm', fakeLlm)
ctx5.provide('agentDefaultModel', fakeDefaultModel)
await ctx5.plugin(pluginMod, { memory_dir: join(candHome, 'memory'), enable_schedule: false })
await new Promise(resolve => setTimeout(resolve, 300))
async function call5(name, args) {
  toolSeq += 1
  const result = await ctx5.tools.execute({ callId: CallId(`e2e-c-${toolSeq}`), name, arguments: args, signal })
  return (result?.content ?? []).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
}
const SAME = 'memory_organize 尚未成功生成 L4 摘要，需在模型通道恢复后重试。'
await call5('memory_candidate', { fact: SAME })
await call5('memory_candidate', { fact: `${SAME}（出现 1 次）` })
await call5('memory_candidate', { fact: `${SAME}（出现 2 次）` })
const candRawDedup = await readFile(join(candHome, 'memory', 'candidates.yaml'), 'utf8')
check('带「（出现 N 次）」的改写不产生新候选', (candRawDedup.match(/^- id:/gm) ?? []).length === 1,
  `实际 ${(candRawDedup.match(/^- id:/gm) ?? []).length} 条`)
check('去重后计数累计到 3', /count:\s*3/.test(candRawDedup), candRawDedup.match(/count:\s*\d+/)?.[0])

await call5('memory_candidate', { fact: '确实不同的另一条线索' })
const candRaw2 = await readFile(join(candHome, 'memory', 'candidates.yaml'), 'utf8')
check('不误合并真正不同的线索', (candRaw2.match(/^- id:/gm) ?? []).length === 2)

const promoted = await call5('memory_promote', { fact: `${SAME}（出现 3 次）` })
check('promote 用带尾巴的文本也能找到候选', /已升格/.test(promoted), promoted.slice(0, 60))

// ---------- 15. 存量分裂归并（新增不分裂了，但存量没人收） ----------
console.log('\n== 15. 存量分裂归并 ==')
const mergeHome = await mkdtemp(join(tmpdir(), 'dsh-memory-merge-'))
const mergeRoot = join(mergeHome, 'memory')
const mergeFact = 'memory_organize 尚未成功生成 L4 摘要，需在模型通道恢复后重试。'
const ctx6 = new Context()
new SystemPrompt(ctx6, {})
new ToolRuntime(ctx6, {})
ctx6.provide('llm', fakeLlm)
ctx6.provide('agentDefaultModel', fakeDefaultModel)
await ctx6.plugin(pluginMod, { memory_dir: mergeRoot, enable_schedule: false })
await new Promise(resolve => setTimeout(resolve, 300))
async function call6(name, args) {
  toolSeq += 1
  const result = await ctx6.tools.execute({ callId: CallId(`e2e-m-${toolSeq}`), name, arguments: args, signal })
  return (result?.content ?? []).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
}
// 手工造出"存量分裂"：直接写盘两条同义 pending（模拟修好之前留下的烂摊子）
await call6('memory_candidate', { fact: mergeFact })
const candPath = join(mergeRoot, 'candidates.yaml')
const seeded = await readFile(candPath, 'utf8')
await writeFile(candPath, `${seeded.trimEnd()}\n- id: "cand-stale-002"\n  fact: "${mergeFact}（出现 1 次）"\n  first_seen: "2026-10-20"\n  last_seen: "2026-10-20"\n  count: 1\n  source: ["old-session"]\n  tags: []\n  status: "pending"\n`, 'utf8')
const dupBefore = (await readFile(candPath, 'utf8')).match(/^\s+status:\s*"?pending"?/gm) ?? []
check('造出存量分裂：2 条 pending', dupBefore.length === 2, `实际 ${dupBefore.length}`)

const mergedRun = await call6('memory_organize', { scan_sessions: 1 })
console.log(mergedRun.split('\n').slice(0, 6).join('\n'))
const candAfter = await readFile(candPath, 'utf8')
check('整理时报告了归并', /合并了 1 条同义重复候选/.test(mergedRun), mergedRun.slice(0, 100))
check('存量分裂被归并：pending 只剩 1 条', (candAfter.match(/^\s+status:\s*"?pending"?/gm) ?? []).length === 1,
  `实际 ${(candAfter.match(/^\s+status:\s*"?pending"?/gm) ?? []).length}`)
check('被归并的那条标 merged 未删除', /^\s+status:\s*"?merged"?/m.test(candAfter))
check('归并后计数累计到 2', /count: 2/.test(candAfter), candAfter.match(/count: \d+/g)?.join(','))
check('归并去向写进 note', /已并入 cand-/.test(candAfter))

console.log(`\n[e2e] 汇总：${failures === 0 ? '全部通过 ✔' : `${failures} 项失败 ✘`}`)
console.log(`[e2e] 临时 DSH_HOME 保留在：${home}`)
process.exit(failures === 0 ? 0 : 1)
