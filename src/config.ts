/** 插件配置（全部有默认值；挂载时通过 cordis.patch.yml 的 config 或宿主 profile 覆盖）。 */

export interface MemoryConfig {
  /** 记忆目录；默认 `$DSH_HOME/memory`（DSH_HOME 缺省 `~/.dsh`）。 */
  memory_dir?: string
  /** 整理用模型走本地 broker 的地址（真钥匙由 broker 注入，代码里只有假 key）。 */
  broker_url?: string
  /** 整理用模型名（broker 按模型名选上游）。 */
  organizer_model?: string
  /** 每日整理时间 `HH:MM` 或 `HH:MM:SS`（本地时区），默认 04:00:00；内部统一归一到秒级。 */
  daily_time?: string
  /** IANA 时区（如 Asia/Shanghai）；默认取宿主本地时区。 */
  time_zone?: string
  /** 整理专用会话 id，默认 memory-organizer。 */
  organizer_session?: string
  /** 是否自动注册每日整理任务（dsh ≥0.2.0-rc.2 生效）；false = 只工具。 */
  enable_schedule?: boolean
  /** 夜间最多扫描多少场会话，默认 12（上限 40）。 */
  scan_sessions?: number
}

export const DEFAULT_CONFIG: MemoryConfig = {
  broker_url: 'http://127.0.0.1:9999',
  organizer_model: 'deepseek-flash',
  daily_time: '04:00:00',
  scan_sessions: 12,
}

/**
 * 归一每日整理时间，**输出恒为 `HH:mm:ss`**。
 *
 * dsh ≥0.2.0-rc.2 的 schedule `daily.time` 只接受 `HH:mm:ss[.SSS]`（秒必填），
 * 传 `HH:mm` 会被 `invalid_rule` 拒绝——这里统一补秒，输入兼容 `H:MM` / `HH:MM` / `HH:MM:SS`。
 */
export function normalizeDailyTime(value?: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((value ?? '').trim())
  if (match === null) return DEFAULT_CONFIG.daily_time as string
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = match[3] === undefined ? 0 : Number(match[3])
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return DEFAULT_CONFIG.daily_time as string
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return DEFAULT_CONFIG.daily_time as string
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) return DEFAULT_CONFIG.daily_time as string
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function normalizeTimeZone(value?: string): string {
  const trimmed = value?.trim()
  if (trimmed) return trimmed
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
