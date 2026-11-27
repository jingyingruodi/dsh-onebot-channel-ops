/**
 * review-stats.js —— 消息准入审查的审计统计（`~/.dsh/qq-review-stats.jsonl`）。
 *
 * 写入只追加 JSONL，单文件超过 REVIEW_STATS_MAX_BYTES 时保留尾部
 * REVIEW_STATS_KEEP_BYTES，并从下一个换行开始写回，绝不留半行；读取只回读尾部
 * 且跳过坏行。每条记录只含审查元数据：时间、会话、来源、结论、耗时、是否命中
 * 缓存、是否失败、模型；**绝不写消息原文、reason 或其它正文派生内容**。
 *
 * 统计是旁路：写入失败只记插件日志，不向调用方抛错，不影响审查结论。
 * 聚合与时间窗口都在这里完成，api.js 只做入参校验和 JSON 输出。
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'

export const REVIEW_STATS_FILE = join(DATA_DIR, 'qq-review-stats.jsonl')
/** 单文件上限；超过后轮转。 */
export const REVIEW_STATS_MAX_BYTES = 4 * 1024 * 1024
/** 轮转后保留的尾部字节。 */
export const REVIEW_STATS_KEEP_BYTES = 512 * 1024
export const REVIEW_STATS_DEFAULT_WINDOW = '24h'
export const REVIEW_STATS_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
export const REVIEW_STATS_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const REVIEW_STATS_DEFAULT_LIMIT = 20
export const REVIEW_STATS_MAX_LIMIT = 100

/** 与 message-review.js 的结论枚举一致；未知 verdict 视为坏行。 */
const VERDICTS = ['allow', 'suspect', 'block', 'hold']
const VERDICT_SET = new Set(VERDICTS)
/** 单次最多回读的尾部字节。文件正常时不超过上限，手写撑大时也只读尾部。 */
const MAX_SCAN_BYTES = REVIEW_STATS_MAX_BYTES
/** 单次最多解析的行数，防止一行一条的超小记录把内存吃满。 */
const MAX_SCAN_LINES = 20000
const MAX_FIELD_CHARS = 200
const MAX_MODEL_CHARS = 200

/** 所有写入字段先转字符串并压掉控制字符，保证一条记录只占一行。 */
function text(value, max = MAX_FIELD_CHARS) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, Math.max(1, max))
}

/**
 * 把调用方给的记录收敛成允许落盘的字段集合。未知字段（例如误传的 text）
 * 一律丢弃；verdict/category 缺失时返回 null。
 * @param {object} record 审查结果元数据
 * @returns {object|null} 可序列化的记录
 */
function buildEntry(record) {
  const verdict = text(record?.verdict, 20)
  const category = text(record?.category, 64)
  if (!VERDICT_SET.has(verdict) || category === '') return null
  const entry = {
    at: new Date().toISOString(),
    sessionId: text(record?.sessionId),
    scope: text(record?.scope, 40),
    kind: text(record?.kind, 20),
  }
  const peerId = text(record?.peerId, 40)
  if (peerId !== '') entry.peerId = peerId
  const senderUin = text(record?.senderUin, 40)
  if (senderUin !== '') entry.senderUin = senderUin
  entry.verdict = verdict
  entry.category = category
  const durationMs = Number(record?.durationMs)
  entry.durationMs = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0
  entry.cacheHit = record?.cacheHit === true
  entry.error = record?.error === true
  const model = text(record?.model, MAX_MODEL_CHARS)
  if (model !== '') entry.model = model
  return entry
}

/**
 * 文件超过上限时保留尾部一个完整行区间。轮转失败不抛给写入口：
 * 下一次追加还会再尝试，最多短暂超过上限。
 * @returns {boolean} 是否发生了轮转
 */
export function rotateReviewStatsIfNeeded() {
  let size
  try {
    size = statSync(REVIEW_STATS_FILE).size
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (size <= REVIEW_STATS_MAX_BYTES) return false
  const start = Math.max(0, size - REVIEW_STATS_KEEP_BYTES)
  const length = size - start
  const fd = openSync(REVIEW_STATS_FILE, 'r')
  let buffer
  try {
    buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset)
      if (read <= 0) break
      offset += read
    }
    buffer = buffer.subarray(0, offset)
  } finally {
    closeSync(fd)
  }
  // 从中间切进来的第一行大概率是半行：丢掉它，保留后面完整记录。
  const newline = buffer.indexOf(0x0a)
  const tail = newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0)
  writeFileSync(REVIEW_STATS_FILE, tail)
  note('review-stats', `统计文件已轮转：原 ${size} 字节，保留 ${tail.length} 字节（上限 ${REVIEW_STATS_MAX_BYTES}）`)
  return true
}

/**
 * 文件末尾是否缺少换行。手写/半截的文件可能没有结尾换行，
 * 直接追加会和最后一条记录粘成一行，两条都读不出来。
 * @returns {boolean} 需要补一个前导换行时 true
 */
function needsLeadingNewline() {
  let fd
  try {
    fd = openSync(REVIEW_STATS_FILE, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return false
    const last = Buffer.allocUnsafe(1)
    const read = readSync(fd, last, 0, 1, size - 1)
    return read === 1 && last[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

/**
 * 追加一条审查统计。失败只记日志并返回 false，绝不抛给审查调用方。
 * @param {object} record 由 message-review.js 填写的审查元数据
 * @returns {boolean} 是否写入成功
 */
export function appendReviewStat(record) {
  const entry = buildEntry(record)
  if (entry === null) {
    note('review-stats', '丢弃 verdict/category 不合法的统计记录')
    return false
  }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
  } catch (error) {
    note('review-stats', `统计写入失败（数据目录不可建）：${error instanceof Error ? error.message : error}`)
    return false
  }
  try {
    rotateReviewStatsIfNeeded()
  } catch (error) {
    note('review-stats', `统计轮转失败，仍继续追加：${error instanceof Error ? error.message : error}`)
  }
  try {
    const prefix = needsLeadingNewline() ? '\n' : ''
    appendFileSync(REVIEW_STATS_FILE, `${prefix}${JSON.stringify(entry)}\n`, 'utf8')
    return true
  } catch (error) {
    note('review-stats', `统计写入失败：${error instanceof Error ? error.message : error}`)
    return false
  }
}

/**
 * 读文件尾部并切行；文件不存在返回空。
 * @returns {{lines:string[],truncated:boolean}} 行与是否只读到尾部
 */
function readTailLines() {
  let fd
  try {
    fd = openSync(REVIEW_STATS_FILE, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return { lines: [], truncated: false }
    throw error
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - MAX_SCAN_BYTES)
    const length = size - start
    if (length === 0) return { lines: [], truncated: false }
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset)
      if (read <= 0) break
      offset += read
    }
    let lines = buffer.subarray(0, offset).toString('utf8').split('\n')
    const cutByLines = lines.length > MAX_SCAN_LINES
    if (cutByLines) lines = lines.slice(-MAX_SCAN_LINES)
    if (start > 0) lines = lines.slice(1)
    return { lines, truncated: start > 0 || cutByLines }
  } finally {
    closeSync(fd)
  }
}

/**
 * 解析一行；坏行返回 null（调用方计数）。只保留已知字段，
 * 即使文件被手写进 text 也不会被读出来。
 * @param {string} line JSONL 一行
 * @returns {object|null} 归一整后的记录
 */
function parseEntry(line) {
  const source = line.trim()
  if (source === '') return null
  let value
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const verdict = text(value.verdict, 20)
  const category = text(value.category, 64)
  const atMs = Date.parse(text(value.at, 40))
  if (!VERDICT_SET.has(verdict) || category === '' || !Number.isFinite(atMs)) return null
  const duration = Number(value.durationMs)
  const entry = {
    at: new Date(atMs).toISOString(),
    atMs,
    sessionId: text(value.sessionId),
    scope: text(value.scope, 40),
    kind: text(value.kind, 20),
    verdict,
    category,
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    cacheHit: value.cacheHit === true,
    error: value.error === true,
  }
  const peerId = text(value.peerId, 40)
  if (peerId !== '') entry.peerId = peerId
  const senderUin = text(value.senderUin, 40)
  if (senderUin !== '') entry.senderUin = senderUin
  const model = text(value.model, MAX_MODEL_CHARS)
  if (model !== '') entry.model = model
  return entry
}

/** 最近秩百分位：p50/p95 取排序后对应的实测样本，不做插值。 */
function percentile(sorted, percent) {
  if (sorted.length === 0) return null
  const rank = Math.ceil((percent / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]
}

/**
 * 解析 `window` 查询参数：`all` 或 `<数字><s|m|h|d>`，默认 24h、上限 30d。
 * @param {unknown} value 查询参数原值
 * @returns {{value:string,ms:number|null}} 窗口标签与毫秒数（all 为 null）
 */
export function parseReviewStatsWindow(value) {
  const raw = value === null || value === undefined || String(value).trim() === ''
    ? REVIEW_STATS_DEFAULT_WINDOW
    : String(value).trim().toLowerCase()
  if (raw === 'all') return { value: 'all', ms: null }
  const match = /^(\d{1,5})([smhd])$/.exec(raw)
  if (match === null) throw new Error('window 只接受 all 或 <数字><s|m|h|d>（例如 1h / 24h / 7d）')
  const multiplier = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2]]
  const ms = Number(match[1]) * multiplier
  if (ms <= 0) throw new Error('window 必须大于 0')
  if (ms > REVIEW_STATS_MAX_WINDOW_MS) throw new Error(`window 最大 ${REVIEW_STATS_MAX_WINDOW_MS / (24 * 60 * 60 * 1000)}d`)
  return { value: raw, ms }
}

/**
 * 聚合窗口内的审查统计。延迟只取真实模型调用（非缓存且 durationMs > 0）；
 * 策略性 hold（超长/附件/无 route/白名单豁免）不产生模型调用，durationMs 记 0，
 * 不参与延迟；审查失败如果确实调用了模型则按实测耗时计入。
 * @param {{now?:number,windowMs?:number|null,window?:string,limit?:number}} [options] 聚合参数
 * @returns {object} total/verdicts/categories/errors/holds/cache/latency/recent 与文件读取信息
 */
export function summarizeReviewStats(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const windowMs = options.windowMs === undefined ? REVIEW_STATS_DEFAULT_WINDOW_MS : options.windowMs
  const label = options.window ?? (windowMs === null ? 'all' : REVIEW_STATS_DEFAULT_WINDOW)
  const limit = Math.min(
    Math.max(1, Math.trunc(Number(options.limit)) || REVIEW_STATS_DEFAULT_LIMIT),
    REVIEW_STATS_MAX_LIMIT
  )
  const since = windowMs === null ? null : now - windowMs
  const scan = readTailLines()
  const entries = []
  let scanned = 0
  let skipped = 0
  for (const line of scan.lines) {
    if (line.trim() === '') continue
    scanned += 1
    const entry = parseEntry(line)
    if (entry === null) {
      skipped += 1
      continue
    }
    if (since !== null && entry.atMs < since) continue
    entries.push(entry)
  }

  const verdicts = { allow: 0, suspect: 0, block: 0, hold: 0 }
  const categoryCounts = {}
  let errors = 0
  let holds = 0
  let cacheHits = 0
  const durations = []
  for (const entry of entries) {
    verdicts[entry.verdict] += 1
    categoryCounts[entry.category] = (categoryCounts[entry.category] ?? 0) + 1
    if (entry.error) errors += 1
    if (entry.verdict === 'hold') holds += 1
    if (entry.cacheHit) cacheHits += 1
    if (!entry.cacheHit && entry.durationMs > 0) durations.push(entry.durationMs)
  }
  durations.sort((left, right) => left - right)
  const total = entries.length
  const categories = Object.fromEntries(
    Object.keys(categoryCounts).sort().map((key) => [key, categoryCounts[key]])
  )

  return {
    window: {
      value: label,
      ms: windowMs,
      since: since === null ? null : new Date(since).toISOString(),
      until: new Date(now).toISOString(),
      scanned,
      skipped,
      truncated: scan.truncated,
    },
    total,
    limit,
    verdicts,
    categories,
    errors,
    holds,
    cache: {
      hits: cacheHits,
      misses: total - cacheHits,
      hitRate: total === 0 ? 0 : Math.round((cacheHits / total) * 10000) / 10000,
    },
    latency: {
      samples: durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length === 0 ? null : durations[durations.length - 1],
    },
    // 最近 N 条：新的在前；只回已知字段，绝不带原文。
    recent: entries.slice(-limit).reverse().map((entry) => {
      const view = {
        at: entry.at,
        sessionId: entry.sessionId,
        scope: entry.scope,
        kind: entry.kind,
      }
      if (entry.peerId !== undefined) view.peerId = entry.peerId
      if (entry.senderUin !== undefined) view.senderUin = entry.senderUin
      view.verdict = entry.verdict
      view.category = entry.category
      view.durationMs = entry.durationMs
      view.cacheHit = entry.cacheHit
      view.error = entry.error
      if (entry.model !== undefined) view.model = entry.model
      return view
    }),
  }
}
