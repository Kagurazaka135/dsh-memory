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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const toUrl = (path) => pathToFileURL(path).href
const HERE = 'G:/code/dsh-memory'

const home = await mkdtemp(join(tmpdir(), 'dsh-memory-e2e-'))
process.env.DSH_HOME = home
console.log(`[e2e] DSH_HOME = ${home}`)

const { Context } = await import(toUrl(require.resolve('@deepseek-ai/cordis', { paths: [HERE] })))
const { default: SystemPrompt } = await import(toUrl(require.resolve('@deepseek-ai/dsh-system-prompt', { paths: [HERE] })))
const { default: ToolRuntime } = await import(toUrl(require.resolve('@deepseek-ai/dsh-tools', { paths: [HERE] })))
const { CallId } = await import(toUrl(require.resolve('@deepseek-ai/dsh-llm', { paths: [HERE] })))
const pluginMod = await import(toUrl(`${HERE}/lib/index.js`))

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
console.log('\n== 4. memory_organize（真 broker 归纳）==')
const dry = await call('memory_organize', { dry_run: true })
console.log(dry.text)
check('dry-run 成功（broker 可达）', /dry-run/.test(dry.text) && !/整理失败/.test(dry.text))

const org = await call('memory_organize', {})
console.log(org.text)
check('整理完成', /整理完成/.test(org.text))

// ---------- 5. brief ----------
console.log('\n== 5. memory_brief ==')
const brief = await call('memory_brief', {})
console.log(brief.text.slice(0, 600))
check('摘要可读', brief.text.includes('#') || brief.text.includes('L3 事实'))

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

console.log(`\n[e2e] 汇总：${failures === 0 ? '全部通过 ✔' : `${failures} 项失败 ✘`}`)
console.log(`[e2e] 临时 DSH_HOME 保留在：${home}`)
process.exit(failures === 0 ? 0 : 1)
