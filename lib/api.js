/**
 * api.js —— 设置页 API（同源 /api/qq-bridge/*）。
 *
 * 与浏览器半侧（lib/client.js）只走同源 HTTP，不碰 RPC。
 */
import { configRevision, getConfig, loadConfig, saveConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { oneBotList, callOneBot } from './onebot.js'
import { listWorkspaceSessions } from './sessions.js'
import { discoverWsEndpoint, discoverHttpEndpoint } from './snowluma.js'
import { wsStatus } from './ws.js'
import { memorySummary, wipeMemory } from './memory.js'
import { proactiveSummary, runProactiveOnce } from './proactive.js'
import { mergePending } from './poll.js'
import { normalizeReaders } from './policy.js'
import { WAKE_MODES } from './policy.js'
import { normalizeSchedules, SCHEDULE_MAX } from './schedule.js'
import { pruneForReaders, queueSummary } from './backlog.js'
import {
  dismissQuarantine,
  isQuarantineId,
  listQuarantine,
  QUARANTINE_DEFAULT_LIMIT,
  QUARANTINE_MAX_LIMIT,
  QuarantineStoreError,
  releaseQuarantine
} from './quarantine.js'
import {
  parseReviewStatsWindow,
  REVIEW_STATS_DEFAULT_LIMIT,
  REVIEW_STATS_MAX_LIMIT,
  summarizeReviewStats
} from './review-stats.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const API_PREFIX = '/api/qq-bridge'

/**
 * 这一份代码是哪个版本、跑在哪个进程里。
 *
 * 为什么非要有：2026-10-29 排查「改完没生效」，翻了半天日志才发现主进程是
 * 上午 11:08 起的，加载的还是旧版 —— 设置页看不到版本，人就只能靠猜。
 * 版本从自己旁边的 package.json 读：插件跑在 profile 的 node_modules 副本里，
 * import.meta.url 指向的就是**正在跑的那份**，而不是源码目录，这点很关键。
 */
const BOOT_AT = new Date().toISOString()

let cachedVersion
function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion
  cachedVersion = ''
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    )
    if (typeof pkg.version === 'string') cachedVersion = pkg.version
  } catch (error) {
    note('api', `读 package.json 版本失败：${error instanceof Error ? error.message : error}`)
  }
  return cachedVersion
}

export function runtimeSummary() {
  return {
    version: pluginVersion(),
    pid: process.pid,
    bootAt: BOOT_AT
  }
}

/**
 * 数字字段的显示值：0 是合法值（比如「一天都不主动」），只有真的缺失/非数字才用默认值。
 * 以前写成 `Number(x) || 默认`，0 会被吞掉换成默认值，面板回读再保存就把 0 改写了。
 */
function numOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** 给设置页看的配置：不返回 token 明文。 */
export function publicConfig() {
  const config = getConfig()
  return {
    enabled: config.enabled === true,
    selfUin: String(config.selfUin ?? ''),
    workspaceCwd: String(config.workspaceCwd ?? ''),
    textPrefix: String(config.textPrefix ?? ''),
    groupOnlyWhenAt: config.groupOnlyWhenAt === true,
    groupContextCount: numOr(config.groupContextCount, 0),
    ambientCooldownMs: numOr(config.ambientCooldownMs, 60000),
    ambientMaxPending: numOr(config.ambientMaxPending, 30),
    ambientPendingMaxChars: numOr(config.ambientPendingMaxChars, 12000),
    splitReply: config.splitReply === true,
    // 分条依据：paragraph（换行分条）/ sentence（按句末标点）
    splitMode: config.splitMode === 'sentence' ? 'sentence' : 'paragraph',
    splitMaxChars: numOr(config.splitMaxChars, 120),
    splitMaxParts: numOr(config.splitMaxParts, 8),
    splitMinChars: numOr(config.splitMinChars, 0),
    splitDelayMinMs: numOr(config.splitDelayMinMs, 200),
    splitDelayMaxMs: numOr(config.splitDelayMaxMs, 700),
    pollMs: numOr(config.pollMs, 2000),
    groupPollMs: numOr(config.groupPollMs, 3000),
    resumeColdSession: config.resumeColdSession !== false,
    autoForwardReply: config.autoForwardReply === true,
    // 0.7.1 起：对话节奏与沉默权
    replyQuietMs: numOr(config.replyQuietMs, 0),
    waitMaxMs: numOr(config.waitMaxMs, 60000),
    closureEnabled: config.closureEnabled !== false,
    // 0.8.0 起：关系记忆
    memoryEnabled: config.memoryEnabled !== false,
    // 0.9.0 起：私聊合并窗口（标记已读的中间态）
    mergeWindowMs: numOr(config.mergeWindowMs, 0),
    mergeMaxWaitMs: numOr(config.mergeMaxWaitMs, 15000),
    mergeMaxMessages: numOr(config.mergeMaxMessages, 10),
    // 0.9.0 起：主动搭话
    proactiveEnabled: config.proactiveEnabled === true,
    proactiveIdleHours: numOr(config.proactiveIdleHours, 6),
    proactiveIdleMaxHours: numOr(config.proactiveIdleMaxHours, 0),
    proactiveDailyMax: numOr(config.proactiveDailyMax, 1),
    proactiveQuietFrom: String(config.proactiveQuietFrom ?? ''),
    proactiveQuietTo: String(config.proactiveQuietTo ?? ''),
    proactiveBackoffMax: numOr(config.proactiveBackoffMax, 4),
    // 空数组 = 所有已绑私聊都可主动（跟 config 里的语义一致，别在前端再翻译一遍）
    proactiveTargets: Array.isArray(config.proactiveTargets)
      ? config.proactiveTargets.map((v) => String(v ?? '')).filter((v) => v !== '')
      : [],
    // 0.8.0 起：上线补历史
    backfillOnStart: config.backfillOnStart !== false,
    backfillMaxPages: numOr(config.backfillMaxPages, 5),
    backfillDeliver: numOr(config.backfillDeliver, 20),
    qzoneRequireConfirm: config.qzoneRequireConfirm !== false,
    imageCopyDir: String(config.imageCopyDir ?? ''),
    wsEnabled: config.wsEnabled !== false,
    wsFallbackPollMs: numOr(config.wsFallbackPollMs, 30000),
    // WS 的地址可以显示（token 不行）。wsToken 有没有配不单独暴露 ——
    // 前端只要知道「地址 + 留空保持原样」就够了，多一个字段没人用就是死的。
    wsUrl: String(config.wsUrl ?? ''),
    // 0.15.0 起：HTTP API 地址也进设置页（token 同样不回显）。
    // 此前它只在配置文件里，改端口得手改 JSON —— 用户明确要这个入口。
    onebotHttp: String(config.onebotHttp ?? ''),
    // 动作发送方式：OneBot 11 标准 'path'（NapCat）还是根路径 {action} 'body'（SnowLuma）
    onebotHttpMode: config.onebotHttpMode === 'path' ? 'path' : 'body',
    // 消息准入审查：全部可写（总开关/范围/并发/超时/字符上限/白名单/附件策略）。
    messageReviewEnabled: config.messageReviewEnabled === true,
    messageReviewScope: config.messageReviewScope === 'all' ? 'all' : 'external',
    messageReviewConcurrency: numOr(config.messageReviewConcurrency, 20),
    messageReviewTimeoutMs: numOr(config.messageReviewTimeoutMs, 5000),
    messageReviewMaxChars: numOr(config.messageReviewMaxChars, 5000),
    messageReviewWhitelist: Array.isArray(config.messageReviewWhitelist)
      ? config.messageReviewWhitelist.map((value) => String(value ?? '').trim()).filter((value) => value !== '')
      : [],
    messageReviewHoldAttachments: config.messageReviewHoldAttachments !== false
  }
}

/** 可数字段：非负有限数才接受。 */
export const NUMERIC_FIELDS = [
  'groupContextCount', 'ambientCooldownMs', 'ambientMaxPending', 'ambientPendingMaxChars', 'splitMaxChars', 'splitMaxParts', 'splitMinChars',
  'splitDelayMinMs', 'splitDelayMaxMs', 'pollMs', 'groupPollMs',
  'replyQuietMs', 'waitMaxMs', 'backfillMaxPages', 'backfillDeliver', 'wsFallbackPollMs',
  'mergeWindowMs', 'mergeMaxWaitMs', 'mergeMaxMessages',
  'proactiveIdleHours', 'proactiveIdleMaxHours', 'proactiveDailyMax', 'proactiveBackoffMax',
  'messageReviewConcurrency', 'messageReviewTimeoutMs', 'messageReviewMaxChars'
]
/** 必须大于 0 的数字字段：0 在循环/分条/上限语义里没有意义，保存时直接 400。 */
const NUMERIC_POSITIVE = new Set([
  'pollMs', 'groupPollMs', 'splitMaxChars', 'splitMaxParts',
  'wsFallbackPollMs', 'backfillMaxPages', 'backfillDeliver', 'mergeMaxMessages'
])
/** 消息审查数值字段的下限：0 会让并发/超时/字符预算语义失效。 */
const REVIEW_NUMERIC_MIN = {
  messageReviewConcurrency: 1,
  messageReviewTimeoutMs: 500,
  messageReviewMaxChars: 100
}
/** 协议端与配置文件的硬上限，防止一次请求把配置撑爆。 */
const MAX_BODY_BYTES = 1024 * 1024
const MAX_SESSION_ID_LENGTH = 200
const MAX_PEERS_PER_TABLE = 2000
/** 这些键会改写结果对象的原型或命中内建属性，一律不当配置键。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
/** 布尔字段。 */
export const BOOLEAN_FIELDS = [
  'groupOnlyWhenAt', 'splitReply', 'resumeColdSession', 'autoForwardReply',
  'closureEnabled', 'memoryEnabled', 'backfillOnStart', 'qzoneRequireConfirm', 'wsEnabled',
  'proactiveEnabled', 'messageReviewHoldAttachments', 'messageReviewEnabled'
]
/** 可编辑的纯文本字段（空串是合法值 —— 比如清空图片目录就回到默认）。 */
export const STRING_FIELDS = ['textPrefix', 'imageCopyDir', 'proactiveQuietFrom', 'proactiveQuietTo']
/**
 * 字符串数组字段：主动搭话名单与消息审查白名单。
 * 提交 `[]` 是合法且有意义的（前者 = 全放开，后者 = 谁都不豁免），
 * 所以不能用「空就跳过」那套。两个字段的条目格式不同，各有专门的清洗函数。
 */
export const ARRAY_FIELDS = ['proactiveTargets', 'messageReviewWhitelist']
/**
 * 枚举字段：只接受列出的值，别的一律丢弃（防止手改配置或旧前端写进一个没人认识的值，
 * 那样 outbound 会静默退回默认分支，行为跟预期不符还查不出来）。
 */
export const ENUM_FIELDS = {
  splitMode: ['paragraph', 'sentence'],
  messageReviewScope: ['external', 'all']
}

/** 主动搭话名单只认 `private:<数字>`：脏数据留在配置里会让功能静默失效，干脆在入口处滤掉。 */
function cleanTargetList(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const item of value) {
    const key = String(item ?? '').trim()
    if (!/^private:\d+$/.test(key)) continue
    if (out.includes(key)) continue
    out.push(key)
    if (out.length >= 200) break
  }
  return out
}

/** 请求体校验失败：走 400，而不是被外层 catch 当成 500。 */
class BadRequest extends Error {}

/** 审查白名单的单条长度与数组上限：挡住一次保存把配置文件撑爆。 */
const REVIEW_WHITELIST_ENTRY_MAX = 64
const REVIEW_WHITELIST_MAX_ITEMS = 200
/** 白名单条目：user:<数字QQ> 或 group:<数字群号>，与 message-review.js 的匹配口径一致。 */
const REVIEW_WHITELIST_ENTRY = /^(?:user|group):\d{1,20}$/

/**
 * 清洗消息审查白名单。
 *
 * 与主动搭话名单不同，这里的条目写错会让人「以为放行了、实际还在审」，
 * 所以非法条目直接 400，不静默丢弃。重复条目按首次出现的顺序去重。
 * @param {any} value 请求体里的白名单
 * @returns {string[]}
 */
function cleanReviewWhitelist(value) {
  if (!Array.isArray(value)) throw new BadRequest('messageReviewWhitelist 必须是字符串数组')
  if (value.length > REVIEW_WHITELIST_MAX_ITEMS) {
    throw new BadRequest(`messageReviewWhitelist 最多 ${REVIEW_WHITELIST_MAX_ITEMS} 条`)
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') throw new BadRequest('messageReviewWhitelist 的每一项都必须是字符串')
    const entry = item.trim()
    if (entry === '') throw new BadRequest('messageReviewWhitelist 不接受空条目')
    if (entry.length > REVIEW_WHITELIST_ENTRY_MAX) {
      throw new BadRequest(`messageReviewWhitelist 单条最长 ${REVIEW_WHITELIST_ENTRY_MAX} 个字符`)
    }
    if (!REVIEW_WHITELIST_ENTRY.test(entry)) {
      throw new BadRequest(`messageReviewWhitelist 条目格式不对：${entry}（形如 user:<QQ号> 或 group:<群号>，只含数字）`)
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/** 数组字段各自的清洗函数；新增数组字段时必须一起加，否则保存会报 500。 */
const ARRAY_CLEANERS = {
  proactiveTargets: cleanTargetList,
  messageReviewWhitelist: cleanReviewWhitelist
}

/** 把设置页提交的可调参数合并进 config（候选副本，写盘成功后才替换单例）。返回是否有改动。 */
function applyTunables(config, body) {
  let changed = false
  if (body === null || typeof body !== 'object') return changed
  for (const key of NUMERIC_FIELDS) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0) {
      throw new BadRequest(`${key} 必须是非负数字`)
    }
    if (NUMERIC_POSITIVE.has(key) && body[key] <= 0) {
      throw new BadRequest(`${key} 必须大于 0`)
    }
    const min = REVIEW_NUMERIC_MIN[key]
    if (min !== undefined && body[key] < min) {
      throw new BadRequest(`${key} 不能小于 ${min}`)
    }
    config[key] = body[key]
    changed = true
  }
  for (const key of BOOLEAN_FIELDS) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'boolean') throw new BadRequest(`${key} 必须是 true 或 false`)
    config[key] = body[key]
    changed = true
  }
  for (const key of STRING_FIELDS) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'string') throw new BadRequest(`${key} 必须是字符串`)
    config[key] = body[key].trim()
    changed = true
  }
  for (const key of ARRAY_FIELDS) {
    if (body[key] === undefined) continue
    const clean = ARRAY_CLEANERS[key]
    if (typeof clean !== 'function') throw new Error(`缺少数组字段清洗函数：${key}`)
    const list = clean(body[key])
    if (list === null) throw new BadRequest(`${key} 必须是字符串数组`)
    config[key] = list
    changed = true
  }
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'string' || !allowed.includes(body[key].trim())) {
      throw new BadRequest(`${key} 只能是 ${allowed.join(' / ')}`)
    }
    config[key] = body[key].trim()
    changed = true
  }
  return changed
}

/**
 * 清洗前端传来的路由表，只留 sessionId / prefix。
 *
 * 只留这两个是因为**只有它们有消费方**：sessionId → deliver.pickSessionId，
 * prefix → deliver.prefixOf（私聊正文前缀）。
 *
 * ⚠️ 以前这里还留 `onlyWhenAt`，但全代码没有任何地方读它（群里「只在 @ 时响应」
 *   只有全局开关 groupOnlyWhenAt）。留着它会让前端以为这个字段生效、写进去却毫无作用，
 *   所以直接删掉 —— 存进去的假配置比不存更坏。
 */
function normalizeRouteTable(table) {
  const out = {}
  if (table === null || typeof table !== 'object') return out
  let count = 0
  for (const [key, value] of Object.entries(table)) {
    const id = String(key ?? '').trim()
    if (id === '' || DANGEROUS_KEYS.has(id) || value === null || typeof value !== 'object') continue
    const route = {}
    if (typeof value.sessionId === 'string' && value.sessionId.trim() !== '') {
      route.sessionId = value.sessionId.trim().slice(0, MAX_SESSION_ID_LENGTH)
    }
    if (typeof value.prefix === 'string' && value.prefix !== '') route.prefix = value.prefix.slice(0, 200)
    if (typeof value.wakeMode === 'string' && WAKE_MODES.includes(value.wakeMode)) route.wakeMode = value.wakeMode
    out[id] = route
    count += 1
    if (count >= MAX_PEERS_PER_TABLE) break
  }
  return out
}

/** ---- 会话级 QQ 权限 API 的入参清洗与视图 ---- */

/** 当前会话 ID：非空且不超长。 */
function sessionIdParam(value) {
  const id = String(value ?? '').trim()
  if (id === '' || id.length > MAX_SESSION_ID_LENGTH) throw new BadRequest('sessionId 不合法')
  return id
}

/** QQ 号/群号：OneBot 的 peer id 就是纯数字。 */
function peerIdParam(value) {
  const id = String(value ?? '').trim()
  if (!/^\d{1,20}$/.test(id)) throw new BadRequest('peerId 必须是纯数字的 QQ 号或群号')
  return id
}

/** kind 只能是 private / group。 */
function kindParam(value) {
  if (value !== 'private' && value !== 'group') throw new BadRequest("kind 只能是 'private' 或 'group'")
  return value
}

/** 列表条数：默认值、上限；非正整数 → 400（面板填大了按上限截断）。 */
function limitParam(value, defaultValue, maxValue) {
  if (value === null || value === undefined || value === '') return defaultValue
  const raw = String(value).trim()
  if (!/^\d{1,9}$/.test(raw)) throw new BadRequest('limit 必须是正整数')
  const limit = Number(raw)
  if (limit < 1) throw new BadRequest('limit 必须大于 0')
  return Math.min(limit, maxValue)
}

/** 隔离区列表条数：默认 50，上限 200。 */
function quarantineLimitParam(value) {
  return limitParam(value, QUARANTINE_DEFAULT_LIMIT, QUARANTINE_MAX_LIMIT)
}

/** 审查统计最近记录条数：默认 20，上限 100。 */
function reviewStatsLimitParam(value) {
  return limitParam(value, REVIEW_STATS_DEFAULT_LIMIT, REVIEW_STATS_MAX_LIMIT)
}

/** 审查统计窗口：默认 24h、上限 30d，也接受 all；非法值 → 400。 */
function reviewStatsWindowParam(value) {
  try {
    return parseReviewStatsWindow(value)
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error))
  }
}

/** 隔离记录 id：列表返回的 16 位十六进制内容哈希，不是文件行号（行号删一条就变）。 */
function quarantineIdParam(value) {
  const id = String(value ?? '').trim()
  if (!isQuarantineId(id)) throw new BadRequest('id 不合法（用列表返回的 id）')
  return id
}

/** owner 备注：只收字符串；压成单行和限长在 quarantine.js 落盘前做。 */
function quarantineNoteParam(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new BadRequest('note 必须是字符串')
  return value
}

const SESSION_ACTIONS = new Set(['add-writer', 'remove-writer', 'add-reader', 'remove-reader', 'set-reader-mode', 'set-writer-mode'])

/** 某个 session 当前的 writer/reader 绑定视图（右栏 QQ 权限页用）。 */
function sessionBindingView(config, sessionId) {
  const writer = []
  const readers = []
  for (const kind of ['private', 'group']) {
    for (const [peerId, route] of Object.entries(config.routes?.[kind] ?? {})) {
      if (route === null || typeof route !== 'object') continue
      if (String(route.sessionId ?? '').trim() !== sessionId) continue
      writer.push({
        kind,
        peerId: String(peerId),
        prefix: String(route.prefix ?? ''),
        wakeMode: typeof route.wakeMode === 'string' && WAKE_MODES.includes(route.wakeMode) ? route.wakeMode : 'wake',
      })
    }
    for (const [peerId, list] of Object.entries(config.readers?.[kind] ?? {})) {
      if (!Array.isArray(list)) continue
      for (const reader of list) {
        if (String(reader?.sessionId ?? '').trim() !== sessionId) continue
        readers.push({
          kind,
          peerId: String(peerId),
          wakeMode: reader.wakeMode,
          backlogMaxMessages: reader.backlogMaxMessages,
          backlogMaxChars: reader.backlogMaxChars,
        })
      }
    }
  }
  writer.sort((left, right) => (left.kind + left.peerId).localeCompare(right.kind + right.peerId))
  readers.sort((left, right) => (left.kind + left.peerId).localeCompare(right.kind + right.peerId))
  return { writer, readers }
}

/** 群监听列表跟着 routes/readers 走：没有绑定/读者的群从 groupUins 里移除。 */
function syncGroupWatch(config) {
  const groups = new Set((Array.isArray(config.groupUins) ? config.groupUins : []).map((value) => String(value)))
  for (const id of Object.keys(config.routes?.group ?? {})) groups.add(String(id))
  for (const [id, list] of Object.entries(config.readers?.group ?? {})) {
    if (Array.isArray(list) && list.length > 0) groups.add(String(id))
  }
  for (const id of [...groups]) {
    const routed = config.routes?.group?.[id] !== undefined
    const read = Array.isArray(config.readers?.group?.[id]) && config.readers.group[id].length > 0
    if (!routed && !read) groups.delete(id)
  }
  config.groupUins = [...groups]
}

/** 普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/**
 * 整表提交的形状校验：必须同时给出 private 与 group 两张子表。
 *
 * 为什么不接受「只传一半」：这是整表替换语义，少一张子表就等于把它清空。
 * 前端一直传完整两张；手写脚本也只有明确传 `{private:{},group:{}}` 才能清表 ——
 * 悄悄清掉用户全部绑定/读者的后果比 400 难查得多。
 */
function requireTables(value, label) {
  if (!isPlainObject(value) || !isPlainObject(value.private) || !isPlainObject(value.group)) {
    throw new BadRequest(`${label} 必须同时提供 private 与 group 两个对象`)
  }
}

/** 读请求体：限长、必须是 JSON 对象；失败抛 BadRequest（400）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (message) => {
      if (settled) return
      settled = true
      reject(new BadRequest(message))
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail('请求体太大（上限 1MB）')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      let parsed
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        parsed = text === '' ? {} : JSON.parse(text)
      } catch {
        fail('请求体不是合法 JSON')
        return
      }
      if (!isPlainObject(parsed)) {
        fail('请求体必须是 JSON 对象')
        return
      }
      settled = true
      resolve(parsed)
    })
    req.on('error', () => fail('请求体读取失败'))
  })
}

function sendJson(res, code, data) {
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(data))
  } catch (error) {
    note('api', `send failed ${error instanceof Error ? error.message : error}`)
  }
}

export function registerApi(ctx) {
  const server = serviceOf(ctx, 'webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') {
    note('api', 'webServer 不可用，跳过 API 注册')
    return
  }
  // register 返回 disposer，必须挂到 ctx.effect 上：
  // 热重载时插件被 dispose，不释放的话下次挂同一个 prefix 会抛
  // "webserver: duplicate prefix route"，接口就 404 了。
  const dispose = server.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      try {
        // 插件路由比宿主的 /api 前缀更长，webServer 是最长前缀优先 —— connection
        // 插件的 Host/Origin + 浏览器凭据栅栏不会执行到。这里必须自己过一遍，
        // 否则本机任意进程、任意网页（text/plain 简单请求免预检 → CSRF）、
        // DNS rebinding 页面都能读写这份配置。
        const connection = serviceOf(ctx, 'connection')
        if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
          note('api', 'connection 服务不可用：拒绝插件 API 请求（无法校验来源）')
          return sendJson(res, 503, { ok: false, error: 'connection service unavailable' })
        }
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        // 设置写接口的 revision 是磁盘 hash，候选却是内存 config。多实例/手工改文件时
        // 内存可能是旧的；每次设置请求先从磁盘重载，避免用旧快照覆盖别人的写入。
        if (['/state', '/schedules', '/save', '/session-state', '/session-save', '/schedule-save'].includes(route)) {
          loadConfig()
        }
        if (route === '/state' && req.method === 'GET') {
          // 三个 OneBot 调用并行：协议端挂死时最坏也只等一次 8s，而不是 24s。
          const selfPromise = (async () => {
            try {
              const info = await callOneBot({ action: 'get_login_info' })
              if (info !== null && info !== undefined && info.retcode === 0 && info.data) {
                return {
                  uin: String(info.data.user_id ?? ''),
                  name: String(info.data.nickname ?? ''),
                }
              }
            } catch (error) {
              note('api', `get_login_info failed: ${error instanceof Error ? error.message : error}`)
            }
            return null
          })()
          const [friends, groups, self] = await Promise.all([
            oneBotList('get_friend_list', 'user_id', 'nickname').catch(() => []),
            oneBotList('get_group_list', 'group_id', 'group_name').catch(() => []),
            selfPromise,
          ])
          const config = getConfig()
          return sendJson(res, 200, {
            ok: true,
            revision: configRevision(),
            self,
            runtime: runtimeSummary(),
            config: publicConfig(),
            ws: wsStatus(),
            memory: memorySummary(),
            proactive: proactiveSummary(),
            merge: mergePending(),
            routes: {
              private: config.routes?.private ?? {},
              group: config.routes?.group ?? {}
            },
            // Slice 3：只读观察者表 + 当前积压概要。面板的 peer 视角和 session 视角
            // 都从这一份推导，不再各算各的。
            readers: config.readers ?? { private: {}, group: {} },
            backlog: queueSummary(),
            sessions: listWorkspaceSessions(ctx),
            friends,
            groups
          })
        }
        if (route === '/schedules' && req.method === 'GET') {
          const config = getConfig()
          return sendJson(res, 200, {
            ok: true,
            revision: configRevision(),
            schedules: normalizeSchedules(config.acceptanceSchedules)
          })
        }
        if (route === '/schedule-save' && req.method === 'POST') {
          const body = await readBody(req)
          if (body.expectedRevision !== undefined) {
            if (typeof body.expectedRevision !== 'number' || !Number.isFinite(body.expectedRevision)) {
              throw new BadRequest('expectedRevision 不合法')
            }
            if (Math.floor(body.expectedRevision) !== configRevision()) {
              return sendJson(res, 409, { ok: false, revision: configRevision(), error: '配置已被其他窗口或工具修改，请刷新后再试' })
            }
          }
          const action = String(body.action ?? '').trim()
          if (!['create', 'update', 'delete', 'enable', 'disable'].includes(action)) throw new BadRequest('未知的定时计划操作')
          const next = JSON.parse(JSON.stringify(getConfig()))
          if (!Array.isArray(next.acceptanceSchedules)) next.acceptanceSchedules = []
          let schedules = normalizeSchedules(next.acceptanceSchedules)
          const id = String(body.id ?? '').trim()
          const existing = id === '' ? null : schedules.find((item) => item.id === id) ?? null
          if ((action === 'update' || action === 'delete' || action === 'enable' || action === 'disable') && existing === null) {
            throw new BadRequest(`找不到定时计划 ${id}`)
          }
          if (action === 'delete') {
            schedules = schedules.filter((item) => item.id !== id)
          } else if (action === 'enable' || action === 'disable') {
            existing.enabled = action === 'enable'
            schedules = schedules.map((item) => item.id === id ? existing : item)
          } else {
            const kind = String(body.kind ?? existing?.target?.kind ?? '').trim()
            const targetId = String(body.target_id ?? existing?.target?.id ?? '').trim()
            if (kind !== 'group' && kind !== 'private') throw new BadRequest('target kind 只能是 group / private')
            if (targetId === '') throw new BadRequest('target_id 不能为空')
            const table = next.routes?.[kind]
            if (!isPlainObject(table) || !Object.hasOwn(table, targetId)) {
              throw new BadRequest(`目标 ${kind}:${targetId} 还没有绑定 writer 会话`)
            }
            const targetRoute = table[targetId]
            if (!isPlainObject(targetRoute) || String(targetRoute.sessionId ?? '').trim() === '') {
              throw new BadRequest(`目标 ${kind}:${targetId} 的 writer 会话为空`)
            }
            if (action === 'create' && schedules.length >= SCHEDULE_MAX) {
              throw new BadRequest(`定时计划最多 ${SCHEDULE_MAX} 条`)
            }
            if (body.weekdays !== undefined && !Array.isArray(body.weekdays)) throw new BadRequest('weekdays 必须是数组')
            if (body.name !== undefined && typeof body.name !== 'string') throw new BadRequest('name 必须是字符串')
            if (body.action_type !== undefined && body.action_type !== 'set' && body.action_type !== 'restore') {
              throw new BadRequest('action_type 只能是 set / restore')
            }
            const currentType = existing?.action?.type ?? 'set'
            const type = body.action_type === 'restore' ? 'restore' : body.action_type === 'set' ? 'set' : currentType
            const sameType = type === currentType
            const nextAction = type === 'restore'
              ? {
                  type: 'restore',
                  fallbackMode: String(body.fallback_mode ?? (sameType ? (existing?.action?.fallbackMode ?? '') : '')),
                  onlyIfUnchanged: body.only_if_unchanged !== undefined
                    ? body.only_if_unchanged !== false
                    : (sameType ? existing?.action?.onlyIfUnchanged !== false : true)
                }
              : {
                  type: 'set',
                  mode: String(body.mode ?? (sameType ? (existing?.action?.mode ?? '') : '')),
                  captureBefore: body.capture_before !== undefined
                    ? body.capture_before !== false
                    : (sameType ? existing?.action?.captureBefore !== false : true)
                }
            const candidate = {
              id: action === 'update' ? existing.id : `sch_${randomUUID().slice(0, 8)}`,
              name: String(body.name ?? existing?.name ?? '定时计划'),
              enabled: existing?.enabled !== false,
              weekdays: Array.isArray(body.weekdays) ? body.weekdays : existing?.weekdays,
              time: String(body.time ?? existing?.time ?? ''),
              timezone: String(body.timezone ?? existing?.timezone ?? 'Asia/Shanghai'),
              target: { kind, id: targetId },
              action: nextAction
            }
            const normalized = normalizeSchedules([candidate])
            if (normalized.length === 0) throw new BadRequest('定时计划参数不合法（周几/时间/模式/target/fallback）')
            schedules = action === 'update'
              ? schedules.map((item) => item.id === id ? normalized[0] : item)
              : [...schedules, normalized[0]]
          }
          next.acceptanceSchedules = schedules
          if (saveConfig(next) !== true) {
            return sendJson(res, 500, { ok: false, error: '配置写盘失败，本次定时计划没有生效' })
          }
          note('api', `schedule-save ${action} id=${id || '-'}`)
          return sendJson(res, 200, {
            ok: true,
            revision: configRevision(),
            schedules: normalizeSchedules(getConfig().acceptanceSchedules)
          })
        }
        if (route === '/session-state' && req.method === 'GET') {
          const url = new URL(req.url ?? '', 'http://localhost')
          const sessionId = sessionIdParam(url.searchParams.get('sessionId'))
          const config = getConfig()
          return sendJson(res, 200, {
            ok: true,
            revision: configRevision(),
            sessionId,
            ...sessionBindingView(config, sessionId),
            backlog: queueSummary(),
            ws: wsStatus()
          })
        }
        if (route === '/session-save' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = sessionIdParam(body.sessionId)
          if (body.expectedRevision !== undefined) {
            if (typeof body.expectedRevision !== 'number' || !Number.isFinite(body.expectedRevision)) {
              throw new BadRequest('expectedRevision 不合法')
            }
            if (Math.floor(body.expectedRevision) !== configRevision()) {
              return sendJson(res, 409, {
                ok: false,
                revision: configRevision(),
                error: '配置已被其他窗口或工具修改，请刷新后再试'
              })
            }
          }
          const action = String(body.action ?? '')
          if (!SESSION_ACTIONS.has(action)) throw new BadRequest('未知的会话权限操作')
          const kind = kindParam(body.kind)
          const peerId = peerIdParam(body.peerId)
          const next = JSON.parse(JSON.stringify(getConfig()))
          if (next.routes === undefined) next.routes = { private: {}, group: {} }
          if (next.routes[kind] === undefined) next.routes[kind] = {}
          if (next.readers === undefined) next.readers = { private: {}, group: {} }
          if (next.readers[kind] === undefined) next.readers[kind] = {}
          if (action === 'add-writer') {
            const existing = next.routes[kind][peerId]
            if (existing !== undefined && String(existing.sessionId ?? '').trim() !== sessionId) {
              return sendJson(res, 409, {
                ok: false,
                revision: configRevision(),
                error: `peer ${peerId} 已经绑定了另一个 writer 会话，一个 peer 只能有一个 writer`
              })
            }
            const writerWakeMode = WAKE_MODES.includes(body.wakeMode) ? body.wakeMode : 'wake'
            next.routes[kind][peerId] = { ...(existing ?? {}), sessionId, wakeMode: writerWakeMode }
            const list = next.readers[kind][peerId]
            if (Array.isArray(list)) {
              const kept = list.filter((reader) => String(reader?.sessionId ?? '').trim() !== sessionId)
              if (kept.length > 0) next.readers[kind][peerId] = kept
              else delete next.readers[kind][peerId]
            }
            if (kind === 'group') syncGroupWatch(next)
          } else if (action === 'remove-writer') {
            const existing = next.routes[kind][peerId]
            if (existing === undefined || String(existing.sessionId ?? '').trim() !== sessionId) {
              return sendJson(res, 409, { ok: false, revision: configRevision(), error: '该 peer 不是本会话的写目标' })
            }
            delete next.routes[kind][peerId]
            if (kind === 'group') syncGroupWatch(next)
          } else if (action === 'set-writer-mode') {
            const existing = next.routes[kind][peerId]
            if (existing === undefined || String(existing.sessionId ?? '').trim() !== sessionId) {
              return sendJson(res, 409, { ok: false, revision: configRevision(), error: '该 peer 不是本会话的写目标' })
            }
            const wakeMode = body.wakeMode
            if (!WAKE_MODES.includes(wakeMode)) throw new BadRequest(`wakeMode 只能是 ${WAKE_MODES.join(' / ')}`)
            existing.wakeMode = wakeMode
          } else if (action === 'add-reader') {
            const writer = next.routes[kind][peerId]
            if (writer !== undefined && String(writer.sessionId ?? '').trim() === sessionId) {
              return sendJson(res, 409, { ok: false, revision: configRevision(), error: '该 peer 已经是本会话的 writer，写权限已包含读权限' })
            }
            const wakeMode = WAKE_MODES.includes(body.wakeMode) ? body.wakeMode : 'muted'
            if (wakeMode === 'ambient') throw new BadRequest('reader 不支持 ambient；ambient 仅 writer 可用')
            const list = Array.isArray(next.readers[kind][peerId]) ? next.readers[kind][peerId].slice() : []
            const index = list.findIndex((reader) => String(reader?.sessionId ?? '').trim() === sessionId)
            const reader = {
              sessionId,
              wakeMode,
              autoReply: 'off',
              read: true,
              write: false,
              backlogMaxMessages: 50,
              backlogMaxChars: 20000
            }
            if (index >= 0) list[index] = { ...list[index], wakeMode }
            else list.push(reader)
            next.readers[kind][peerId] = list
            if (kind === 'group') syncGroupWatch(next)
          } else if (action === 'remove-reader') {
            const list = Array.isArray(next.readers[kind][peerId])
              ? next.readers[kind][peerId].filter((reader) => String(reader?.sessionId ?? '').trim() !== sessionId)
              : []
            if (list.length > 0) next.readers[kind][peerId] = list
            else delete next.readers[kind][peerId]
            if (kind === 'group') syncGroupWatch(next)
          } else {
            const wakeMode = body.wakeMode
            if (!WAKE_MODES.includes(wakeMode)) throw new BadRequest(`wakeMode 只能是 ${WAKE_MODES.join(' / ')}`)
            if (wakeMode === 'ambient') throw new BadRequest('reader 不支持 ambient；ambient 仅 writer 可用')
            const list = next.readers[kind][peerId]
            if (!Array.isArray(list)) {
              return sendJson(res, 409, { ok: false, revision: configRevision(), error: '该 peer 还不是本会话的只读订阅' })
            }
            const index = list.findIndex((reader) => String(reader?.sessionId ?? '').trim() === sessionId)
            if (index < 0) {
              return sendJson(res, 409, { ok: false, revision: configRevision(), error: '该 peer 还不是本会话的只读订阅' })
            }
            list[index] = { ...list[index], wakeMode }
          }
          if (saveConfig(next) !== true) {
            return sendJson(res, 500, { ok: false, error: '配置写盘失败（磁盘只读或路径不可写），本次修改没有生效' })
          }
          const pruned = pruneForReaders(getConfig())
          note('api', `session-save ${action} session=${sessionId} kind=${kind} peer=${peerId}`)
          return sendJson(res, 200, {
            ok: true,
            revision: configRevision(),
            sessionId,
            ...sessionBindingView(getConfig(), sessionId),
            backlog: queueSummary(),
            ws: wsStatus(),
            pruned
          })
        }
        if (route === '/memory-clear' && req.method === 'POST') {
          // 「她把我忘了」的后悔药：清空整张关系卡表（不可撤销，前端必须二次确认）
          const ok = wipeMemory()
          note('api', `memory cleared ok=${ok}`)
          return sendJson(res, ok ? 200 : 500, { ok, memory: memorySummary() })
        }
        if (route === '/proactive-now' && req.method === 'POST') {
          // 设置页的「现在试一次」：忽略开关/配额/空闲/静默，立刻投一次。
          // 为什么允许在开关关着时也能试：不试一下谁也不知道手感对不对。
          // body.only 指定对象（`private:123`）；不传按「最久没被主动过」轮转。
          const body = await readBody(req)
          const only = typeof body?.only === 'string' ? body.only : ''
          const result = await runProactiveOnce(ctx, { force: true, only })
          note('api', `proactive-now sent=${result.sent} skipped=${result.skipped.map((s) => `${s.key}:${s.reason}`).join(',') || '-'}`)
          return sendJson(res, 200, { ok: true, ...result, proactive: proactiveSummary() })
        }
        if (route === '/review-stats' && req.method === 'GET') {
          // owner 查看审查量/结论分布/延迟；只读统计文件，永远不碰原文。
          const url = new URL(req.url ?? '', 'http://localhost')
          const window = reviewStatsWindowParam(url.searchParams.get('window'))
          const limit = reviewStatsLimitParam(url.searchParams.get('limit'))
          return sendJson(res, 200, {
            ok: true,
            ...summarizeReviewStats({ window: window.value, windowMs: window.ms, limit })
          })
        }
        if (route === '/review-quarantine' && req.method === 'GET') {
          // owner 查看隔离区：只读，不写盘；最近 N 条，新的在前。
          const url = new URL(req.url ?? '', 'http://localhost')
          const limit = quarantineLimitParam(url.searchParams.get('limit'))
          return sendJson(res, 200, { ok: true, ...listQuarantine(limit) })
        }
        if ((route === '/review-quarantine-release' || route === '/review-quarantine-dismiss') && req.method === 'POST') {
          // owner 处置：按 id 从 JSONL 摘掉这条 + 写审计流水。
          // 不投递原文 —— 放行只代表「记下了这个决定」，让被拦文案重新进会话是另一件事。
          const body = await readBody(req)
          const id = quarantineIdParam(body.id)
          const action = route === '/review-quarantine-release' ? 'release' : 'dismiss'
          let result
          try {
            const noteText = quarantineNoteParam(body.note)
            result = action === 'release'
              ? releaseQuarantine(id, noteText)
              : dismissQuarantine(id, noteText)
          } catch (error) {
            if (error instanceof QuarantineStoreError) {
              return sendJson(res, 409, { ok: false, error: error.message })
            }
            throw error
          }
          if (result.removed === 0) {
            return sendJson(res, 404, { ok: false, error: '没有找到这条隔离记录（可能已被放行、忽略或清理）' })
          }
          note('api', `review-quarantine ${action} id=${id} removed=${result.removed}`)
          return sendJson(res, 200, { ok: true, action, id, removed: result.removed })
        }
        if (route === '/save' && req.method === 'POST') {
          const body = await readBody(req)
          // 乐观并发：别的窗口 / qq_mute 工具改过配置后，旧草稿保存会被 409 拦下，
          // 而不是把对方的修改静默覆盖掉。
          if (body.revision !== undefined) {
            if (typeof body.revision !== 'number' || !Number.isFinite(body.revision)) {
              throw new BadRequest('revision 不合法')
            }
            const currentRevision = configRevision()
            if (Math.floor(body.revision) !== currentRevision) {
              return sendJson(res, 409, {
                ok: false,
                revision: currentRevision,
                error: '配置已被其他窗口或工具修改，请重新载入后再保存',
              })
            }
          }
          // 副本上应用：写盘失败时内存配置保持原样，不会再出现「保存失败但已生效」。
          const next = JSON.parse(JSON.stringify(getConfig()))
          let nextHttp = null
          if (body.onebotHttp !== undefined) {
            if (typeof body.onebotHttp !== 'string') throw new BadRequest('onebotHttp 必须是字符串')
            const raw = body.onebotHttp.trim()
            if (raw !== '') {
              let parsed = null
              try {
                parsed = new URL(raw)
              } catch {
                parsed = null
              }
              if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
                throw new BadRequest('HTTP API 地址要形如 http://127.0.0.1:3000/（协议 + 主机都要有）')
              }
              const port = Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port)
              if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new BadRequest(`HTTP API 端口不合法：${parsed.port}`)
              }
              nextHttp = raw
            }
          }
          if (body.routes !== undefined) {
            requireTables(body.routes, 'routes')
            next.routes = {
              private: normalizeRouteTable(body.routes.private),
              group: normalizeRouteTable(body.routes.group),
            }
            // 绑定即监听：群表里的群号自动进监听列表。
            next.groupUins = Object.keys(next.routes.group)
          }
          if (body.readers !== undefined) {
            requireTables(body.readers, 'readers')
            next.readers = normalizeReaders(body.readers)
          }
          if (body.workspaceCwd !== undefined) {
            if (typeof body.workspaceCwd !== 'string') throw new BadRequest('workspaceCwd 必须是字符串')
            next.workspaceCwd = body.workspaceCwd
          }
          if (body.wsUrl !== undefined) {
            if (typeof body.wsUrl !== 'string') throw new BadRequest('wsUrl 必须是字符串')
            // 留空 = 保持原样（前端不回显凭据，不能把已有地址清掉）
            if (body.wsUrl.trim() !== '') next.wsUrl = body.wsUrl.trim()
          }
          if (body.wsToken !== undefined && typeof body.wsToken !== 'string') throw new BadRequest('wsToken 必须是字符串')
          if (typeof body.wsToken === 'string' && body.wsToken.trim() !== '') next.wsToken = body.wsToken.trim()
          if (nextHttp !== null) next.onebotHttp = nextHttp
          if (body.onebotHttpMode !== undefined) {
            if (body.onebotHttpMode !== 'body' && body.onebotHttpMode !== 'path') {
              throw new BadRequest("onebotHttpMode 只能是 'body'（SnowLuma）或 'path'（NapCat/OneBot 11 标准）")
            }
            next.onebotHttpMode = body.onebotHttpMode
          }
          if (body.token !== undefined && typeof body.token !== 'string') throw new BadRequest('token 必须是字符串')
          if (typeof body.token === 'string' && body.token.trim() !== '') next.token = body.token.trim()
          applyTunables(next, body)
          if (saveConfig(next) !== true) {
            return sendJson(res, 500, {
              ok: false,
              error: '配置写盘失败（磁盘只读或路径不可写），本次修改没有生效',
            })
          }
          // readers 表变了之后，按新表清理积压：删掉的读者 / off 的读者的队列直接删，
          // muted 的队列保留（手动 qq_read 还能取）；takeForStep 另有二次校验。
          const pruned = pruneForReaders(getConfig())
          note('api', `saved routes private=${Object.keys(next.routes?.private ?? {}).length} group=${Object.keys(next.routes?.group ?? {}).length} readers private=${Object.keys(next.readers?.private ?? {}).length} group=${Object.keys(next.readers?.group ?? {}).length} prunedQueues=${pruned} ws=${next.wsEnabled === false ? 'off' : next.wsUrl}`)
          return sendJson(res, 200, {
            ok: true,
            revision: configRevision(),
            routes: next.routes,
            readers: next.readers,
            config: publicConfig(),
          })
        }
        if (route === '/detect-ws' && req.method === 'POST') {
          // 自动发现 SnowLuma 的 WS 接入点（省得手动抄 token）
          const config = getConfig()
          const body = await readBody(req)
          if (typeof body?.snowlumaConfigDir === 'string' && body.snowlumaConfigDir.trim() !== '') {
            config.snowlumaConfigDir = body.snowlumaConfigDir.trim()
          }
          const endpoint = discoverWsEndpoint(String(config.snowlumaConfigDir ?? ''))
          if (endpoint === null) {
            return sendJson(res, 404, {
              ok: false,
              error: '没找到 SnowLuma 的 WS 接入点。可以手动填地址和 token（见 SnowLuma 的 config/onebot_*.json）。'
            })
          }
          config.wsUrl = endpoint.url
          config.wsToken = endpoint.token
          saveConfig()
          return sendJson(res, 200, { ok: true, url: endpoint.url, source: endpoint.source })
        }
        if (route === '/detect-http' && req.method === 'POST') {
          // 0.15.0：自动发现 SnowLuma 的 HTTP API 接入点（与 WS 那套 token 不是一回事）
          const config = getConfig()
          const body = await readBody(req)
          if (typeof body?.snowlumaConfigDir === 'string' && body.snowlumaConfigDir.trim() !== '') {
            config.snowlumaConfigDir = body.snowlumaConfigDir.trim()
          }
          const endpoint = discoverHttpEndpoint(String(config.snowlumaConfigDir ?? ''))
          if (endpoint === null) {
            return sendJson(res, 404, {
              ok: false,
              error: '没找到 SnowLuma 的 HTTP 接入点。可以手动填地址和 token（见 SnowLuma 的 config/onebot_*.json 的 httpServers）。'
            })
          }
          config.onebotHttp = endpoint.url
          if (endpoint.token !== '') config.token = endpoint.token
          saveConfig()
          return sendJson(res, 200, { ok: true, url: endpoint.url, source: endpoint.source, hasToken: endpoint.token !== '' })
        }
        return sendJson(res, 404, { ok: false, error: `unknown route: ${route}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        note('api', `${route} threw ${message}`)
        if (error instanceof BadRequest) return sendJson(res, 400, { ok: false, error: message })
        return sendJson(res, 500, { ok: false, error: message })
      }
    }
  })
  if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-onebot-channel: api route')
  note('api', `registered at ${API_PREFIX}`)
}
