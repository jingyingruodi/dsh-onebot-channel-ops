/**
 * quarantine.js —— 消息准入审查隔离区（`~/.dsh/qq-review-quarantine.jsonl`）的 owner 侧读取与处置。
 *
 * 写入只有 message-review.js 一处（追加 JSONL，字段 sessionId/kind/peerId/
 * messageId/verdict/category/reason/rawText/at）；这里不重新定义格式，也不改它：
 * 只读最近若干条，并在 owner 放行/忽略时把某一条从队列里摘掉、把决定写进审计文件。
 *
 * 读取有界：列表只回读文件尾部若干字节，坏行跳过并计数；重写有界：超过安全体积
 * 直接拒绝，绝不「只按读到的那部分重写」—— 那样会把没读到的前半段悄悄删掉。
 * 处置走「临时文件 + rename」：原文件在 rename 之前始终是完整的。
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'

/** 与 message-review.js 的追加写入同一个文件（只读）。 */
export const QUARANTINE_FILE = join(DATA_DIR, 'qq-review-quarantine.jsonl')
/** 放行/忽略的审计流水：只记决定与记录元数据，不复制原文。 */
export const QUARANTINE_AUDIT_FILE = join(DATA_DIR, 'qq-review-quarantine-released.jsonl')
export const QUARANTINE_DEFAULT_LIMIT = 50
export const QUARANTINE_MAX_LIMIT = 200

/** 列表单次最多回读的尾部字节：200 条 × 5 KB 正文还有富余。 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024
/** 单次最多解析的行数：文件被写成一行一个换行时也不至于把内存吃满。 */
const MAX_SCAN_LINES = 20000
/** 重写前允许的整文件上限；超过就拒绝，换成流式重写在进程内不可中断，反而会丢记录。 */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024
/** 单条 rawText 回给页面的上限；id 用截断前的原文派生，保证两次读一致。 */
const MAX_RAW_CHARS = 8000
const MAX_REASON_CHARS = 500
const MAX_NOTE_CHARS = 500
const ID_LENGTH = 16
const ID_PATTERN = new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`)

/**
 * 隔离区的可恢复失败：api.js 据此回 409，而不是当成 500。
 */
export class QuarantineStoreError extends Error {
  /**
   * @param {string} message 给 owner 看的、可操作的原因
   * @param {'too-large'|'audit-write-failed'} code 失败类别
   */
  constructor(message, code) {
    super(message)
    this.name = 'QuarantineStoreError'
    this.code = code
  }
}

/**
 * 列表返回的 id 是否合法（16 位小写十六进制）。
 * @param {unknown} value 待检查值
 * @returns {boolean} 合法时 true
 */
export function isQuarantineId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** 文本字段统一转字符串（JSON 里手写进非字符串也别把整条记录丢掉）。 */
function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 由记录内容派生稳定 id：同一行读多少次都一样，内容变了 id 才变。
 * @param {{at:string,sessionId:string,kind:string,peerId:string,messageId:string,rawText:string}} fields 参与派生的字段
 * @returns {string} 16 位小写十六进制
 */
function recordId(fields) {
  const basis = [fields.at, fields.sessionId, fields.kind, fields.peerId, fields.messageId, fields.rawText]
    .map((value) => text(value))
    .join('\u0000')
  return createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, ID_LENGTH)
}

/**
 * 解析一行；坏行返回 null（调用方计数）。
 * @param {string} line 文件里的一行
 * @returns {{id:string,at:string,sessionId:string,kind:string,peerId:string,messageId:string,verdict:string,category:string,reason:string,rawText:string,rawTextTruncated?:true}|null} 记录或 null
 */
function parseLine(line) {
  const source = line.trim()
  if (source === '') return null
  let value
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const base = {
    id: '',
    at: text(value.at),
    sessionId: text(value.sessionId),
    kind: text(value.kind),
    peerId: text(value.peerId),
    messageId: text(value.messageId),
    verdict: text(value.verdict),
    category: text(value.category),
    reason: text(value.reason).slice(0, MAX_REASON_CHARS),
    rawText: text(value.rawText)
  }
  const id = recordId(base)
  const truncated = base.rawText.length > MAX_RAW_CHARS
  const record = { ...base, id, rawText: truncated ? base.rawText.slice(0, MAX_RAW_CHARS) : base.rawText }
  if (truncated) record.rawTextTruncated = true
  return record
}

/**
 * 读文件尾部并切成行；文件不存在返回空。
 * @param {string} path 文件路径
 * @param {number} maxBytes 最多回读的尾部字节
 * @returns {{lines:string[],truncated:boolean}} 行、是否只读到尾部
 */
function readTailLines(path, maxBytes) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return { lines: [], truncated: false }
    throw error
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
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
    // 从中间切进来的第一行大概率是半行：丢掉它，而不是把它当坏行报出来。
    if (start > 0) lines = lines.slice(1)
    return { lines, truncated: start > 0 || cutByLines }
  } finally {
    closeSync(fd)
  }
}

/**
 * 读整个文件；超过体积上限返回 null（不读、不改）。
 * @param {string} path 文件路径
 * @returns {{text:string,size:number}|null} 内容或 null（文件不存在也返回 null）
 */
function readWholeFile(path) {
  let size
  try {
    size = statSync(path).size
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (size > MAX_REWRITE_BYTES) return { text: '', size }
  return { text: readFileSync(path, 'utf8'), size }
}

/**
 * 读最近 N 条隔离记录，新的在前。
 * @param {number} [limit] 条数，默认 50，上限 200
 * @returns {{records:object[],total:number,skipped:number,truncated:boolean,limit:number}} 列表视图
 */
export function listQuarantine(limit = QUARANTINE_DEFAULT_LIMIT) {
  const cap = Math.min(Math.max(1, Math.trunc(Number(limit)) || QUARANTINE_DEFAULT_LIMIT), QUARANTINE_MAX_LIMIT)
  const scan = readTailLines(QUARANTINE_FILE, MAX_SCAN_BYTES)
  const records = []
  let skipped = 0
  for (const line of scan.lines) {
    if (line.trim() === '') continue
    const record = parseLine(line)
    if (record === null) {
      skipped += 1
      continue
    }
    records.push(record)
  }
  if (skipped > 0) note('quarantine', `列表跳过 ${skipped} 行坏记录（${QUARANTINE_FILE}）`)
  return { records: records.slice(-cap).reverse(), total: records.length, skipped, truncated: scan.truncated, limit: cap }
}

/**
 * 原子重写：先写同目录临时文件，再 rename 覆盖；失败时清理临时文件、原文件不动。
 * @param {string} path 目标文件
 * @param {string} content 完整新内容
 * @returns {void}
 */
function writeAtomically(path, content) {
  mkdirSync(DATA_DIR, { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败不该掩盖真正的写入错误
    }
    throw error
  }
}

/** owner 备注压成单行并限长，别让一条审计变成多行 JSON。 */
function cleanNote(value) {
  return text(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS)
}

/**
 * 把一条记录标记为已处置（放行或忽略）并从队列里摘掉。
 *
 * 顺序是先追加审计、再原子重写队列：重写失败时记录还在队列里（可以重试），
 * 不会出现「记录消失了却没有任何处置痕迹」。审计只记元数据与原文长度，不复制原文。
 *
 * @param {string} id 列表返回的 id
 * @param {'release'|'dismiss'} action 处置方式
 * @param {string} [noteText] owner 备注
 * @returns {{removed:number,action:'release'|'dismiss'}} removed=0 表示队列里没有这条
 */
export function decideQuarantine(id, action, noteText = '') {
  if (action !== 'release' && action !== 'dismiss') throw new Error(`quarantine: unknown action ${action}`)
  if (!isQuarantineId(id)) throw new Error('quarantine: invalid id')
  const whole = readWholeFile(QUARANTINE_FILE)
  if (whole === null) return { removed: 0, action }
  if (whole.size > MAX_REWRITE_BYTES) {
    throw new QuarantineStoreError(
      `隔离队列已有 ${whole.size} 字节，超过可安全重写的 ${MAX_REWRITE_BYTES} 字节上限；请先把 ${QUARANTINE_FILE} 归档或清空`,
      'too-large'
    )
  }
  const kept = []
  const decided = []
  for (const line of whole.text.split('\n')) {
    if (line.trim() === '') continue
    const record = parseLine(line)
    if (record !== null && record.id === id) {
      decided.push(record)
      continue
    }
    kept.push(line)
  }
  if (decided.length === 0) return { removed: 0, action }
  appendAudit(action, id, decided, noteText)
  writeAtomically(QUARANTINE_FILE, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
  return { removed: decided.length, action }
}

/**
 * 追加一条处置审计。原文只留长度标记，不二次落盘。
 * @param {'release'|'dismiss'} action 处置方式
 * @param {string} id 记录 id
 * @param {Array<object>} decided 被摘掉的记录（已解析）
 * @param {string} noteText owner 备注
 * @returns {void}
 */
function appendAudit(action, id, decided, noteText) {
  const at = new Date().toISOString()
  const lines = decided.map((record) => JSON.stringify({
    action,
    id,
    at,
    note: cleanNote(noteText),
    record: {
      at: record.at,
      sessionId: record.sessionId,
      kind: record.kind,
      peerId: record.peerId,
      messageId: record.messageId,
      verdict: record.verdict,
      category: record.category,
      reason: record.reason,
      rawTextChars: record.rawText.length
    }
  }))
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(QUARANTINE_AUDIT_FILE, `${lines.join('\n')}\n`, 'utf8')
  } catch (error) {
    throw new QuarantineStoreError(
      `审计文件写不进去（${QUARANTINE_AUDIT_FILE}），本次处置没有生效：${error instanceof Error ? error.message : error}`,
      'audit-write-failed'
    )
  }
}

/**
 * owner 放行：从隔离队列摘掉并记审计。
 * @param {string} id 列表返回的 id
 * @param {string} [noteText] owner 备注
 * @returns {{removed:number,action:'release'|'dismiss'}} removed=0 表示没有这条
 */
export function releaseQuarantine(id, noteText = '') {
  return decideQuarantine(id, 'release', noteText)
}

/**
 * owner 忽略：同样摘掉并记审计，但不投递。
 * @param {string} id 列表返回的 id
 * @param {string} [noteText] owner 备注
 * @returns {{removed:number,action:'release'|'dismiss'}} removed=0 表示没有这条
 */
export function dismissQuarantine(id, noteText = '') {
  return decideQuarantine(id, 'dismiss', noteText)
}
