/**
 * policy.js —— peer → readers 的只读观察者策略（Slice 1）。
 *
 * 这是「超级拼装」里新增的路由/策略层的最小起点：
 *   - routes 仍然决定每个 peer 的唯一 writer；
 *   - readers 只增加接收方，不改变 writer；
 *   - 同一个 session 可以读多个 peer，一个 peer 也可以有多个 reader。
 *
 * 默认 wakeMode 是 muted：新读者不会意外唤醒会话，必须显式选 wake/backlog 或手动
 * qq_read 才拿到消息。手写配置里只写 session id 的简写同样按 muted 处理。
 */

export const WAKE_MODES = Object.freeze(['wake', 'ambient', 'backlog', 'muted', 'off'])
export const READER_WAKE_MODES = Object.freeze(['wake', 'backlog', 'muted', 'off'])

const DEFAULT_WAKE_MODE = 'muted'
const DEFAULT_BACKLOG_MAX_MESSAGES = 50
const DEFAULT_BACKLOG_MAX_CHARS = 20000
/** 单个 peer 最多挂多少个读者；sessionId 最长多少字符（防脏配置撑爆文件）。 */
const MAX_READERS_PER_PEER = 32
const MAX_SESSION_ID_LENGTH = 200
/** 这些键会改写结果对象的原型或命中内建属性，一律不当 peer key。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const KINDS = ['private', 'group']

function normalizeMode(value) {
  const mode = String(value ?? '').trim()
  return WAKE_MODES.includes(mode) ? mode : DEFAULT_WAKE_MODE
}

function normalizePositiveInt(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

/** 把一条 reader 声明统一成对象；字符串等价于 { sessionId }。 */
function normalizeReader(item) {
  if (typeof item === 'string') {
    const sessionId = item.trim().slice(0, MAX_SESSION_ID_LENGTH)
    return sessionId === '' ? null : {
      sessionId,
      wakeMode: DEFAULT_WAKE_MODE,
      autoReply: 'off',
      read: true,
      write: false,
      backlogMaxMessages: DEFAULT_BACKLOG_MAX_MESSAGES,
      backlogMaxChars: DEFAULT_BACKLOG_MAX_CHARS
    }
  }
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const sessionId = String(item.sessionId ?? item.id ?? '').trim().slice(0, MAX_SESSION_ID_LENGTH)
  if (sessionId === '') return null
  return {
    sessionId,
    wakeMode: READER_WAKE_MODES.includes(String(item.wakeMode ?? '').trim()) ? String(item.wakeMode).trim() : DEFAULT_WAKE_MODE,
    autoReply: 'off',
    read: true,
    write: false,
    backlogMaxMessages: normalizePositiveInt(item.backlogMaxMessages, DEFAULT_BACKLOG_MAX_MESSAGES),
    backlogMaxChars: normalizePositiveInt(item.backlogMaxChars, DEFAULT_BACKLOG_MAX_CHARS)
  }
}

/**
 * 归一化配置里的 readers。
 *
 * 接受：
 *   readers: { private: { "10001": ["sessionB"] }, group: { "123": [{ sessionId: "sessionC", wakeMode: "muted" }] } }
 * 也接受 peer 值为单个字符串/对象，便于手写配置。
 */
export function normalizeReaders(raw) {
  const out = { private: {}, group: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const kind of KINDS) {
    const table = raw[kind]
    if (table === null || typeof table !== 'object' || Array.isArray(table)) continue
    for (const [peerIdRaw, value] of Object.entries(table)) {
      const peerId = String(peerIdRaw ?? '').trim()
      if (peerId === '' || DANGEROUS_KEYS.has(peerId)) continue
      const items = Array.isArray(value) ? value : [value]
      const seen = new Set()
      const list = []
      for (const item of items) {
        const reader = normalizeReader(item)
        if (reader === null || seen.has(reader.sessionId)) continue
        seen.add(reader.sessionId)
        list.push(reader)
        if (list.length >= MAX_READERS_PER_PEER) break
      }
      if (list.length > 0) out[kind][peerId] = list
    }
  }
  return out
}

/**
 * 查询某个 peer 的只读观察者。
 *
 * @param {object} config - loadConfig() 之后的配置。
 * @param {'private'|'group'} kind
 * @param {string|number} peerId
 * @returns {{sessionId: string, wakeMode: string, autoReply: string, read: boolean, write: boolean, backlogMaxMessages: number, backlogMaxChars: number}[]}
 */
export function readersFor(config, kind, peerId) {
  if (config === null || config === undefined) return []
  const table = config.readers?.[kind]
  if (table === null || typeof table !== 'object') return []
  const list = table[String(peerId ?? '').trim()]
  return Array.isArray(list) ? list : []
}

/** 只返回 wake 模式（Slice 1 可立即投递）的观察者。 */
export function wakingReadersFor(config, kind, peerId) {
  return readersFor(config, kind, peerId).filter((reader) => reader.wakeMode === 'wake')
}

/** 收集所有出现在 routes 里的 writer session id。 */
function writerSessionsOf(config) {
  const out = []
  const routes = config?.routes
  if (routes === null || typeof routes !== 'object') return out
  for (const kind of KINDS) {
    const table = routes[kind]
    if (table === null || typeof table !== 'object') continue
    for (const route of Object.values(table)) {
      if (route === null || typeof route !== 'object') continue
      const sessionId = String(route.sessionId ?? '').trim()
      if (sessionId !== '') out.push(sessionId)
    }
  }
  return out
}

/**
 * 判断 session 是否只是 readers 里的只读观察者（从不是任何 peer 的 writer）。
 *
 * Slice 1 用它挡 qq_send：读者会话可以读，但不能向 QQ 发消息。
 * 如果同一 session 同时是某个 peer 的 writer，则不算只读（按 writer 处理）。
 *
 * ⚠️ 比较会话必须和 writerPeersOf 用同一套容差（同 sameSessionId）：
 *   配置里写 "session-reader-a"、运行时 exec.agent.id 是 "reader-a" 的情况真实存在
 *   （ensureAgent 就是把两种写法当同一会话）。以前这里精确比较 → 读者被算成
 *   「不是读者」→ isReadOnlySession=false → qq_send 放行，等于绕过只读限制。
 */
export function isReadOnlySession(config, sessionId) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return false
  const readers = config?.readers
  if (readers === null || typeof readers !== 'object') return false
  let found = false
  for (const kind of KINDS) {
    const table = readers[kind]
    if (table === null || typeof table !== 'object') continue
    for (const list of Object.values(table)) {
      if (!Array.isArray(list)) continue
      if (list.some((reader) => sameSessionId(reader?.sessionId, id))) {
        found = true
        break
      }
    }
    if (found) break
  }
  return found && !writerSessionsOf(config).some((writer) => sameSessionId(writer, id))
}

/** 会话 ID 比较：容忍 routes 里常见的 "session-" 前缀差异。 */
function sameSessionId(left, right) {
  const a = String(left ?? '').trim()
  const b = String(right ?? '').trim()
  if (a === b) return true
  const strip = (value) => value.startsWith('session-') ? value.slice('session-'.length) : value
  return strip(a) === strip(b)
}

/** 两个会话 id 是否指同一个会话（供 deliver/工具层做 writer 判重）。 */
export function isSameSession(left, right) {
  return sameSessionId(left, right)
}

/** 某个 session 在 routes 里的写目标列表。 */
export function writerPeersOf(config, sessionId) {
  const out = []
  const routes = config?.routes
  if (routes === null || typeof routes !== 'object') return out
  for (const kind of KINDS) {
    const table = routes[kind]
    if (table === null || typeof table !== 'object') continue
    for (const [peerId, route] of Object.entries(table)) {
      if (route === null || typeof route !== 'object') continue
      if (sameSessionId(route.sessionId, sessionId)) out.push({ kind, id: String(peerId) })
    }
  }
  return out
}

/**
 * 判断某个 session 是否有权向 target peer 写消息（Slice 3 + 审计收紧）。
 *
 * - 只读观察者：直接 false。
 * - 该 session 在 routes 里**一个写目标都没有**：false。
 *   旧行为是「交给 allowlist 放行」，但那等于任意无关 DSH 会话都能往已绑定 peer
 *   发 QQ 消息 —— 被提示注入的无关会话就能外发，与「每个 peer 只有一个 writer」矛盾。
 * - 有写目标：target 必须命中其中一个写目标。
 * - sessionId 为空（拿不到会话身份）：false —— 写操作必须能证明身份。
 */
export function canWritePeer(config, sessionId, target) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return false
  if (isReadOnlySession(config, id)) return false
  const peers = writerPeersOf(config, id)
  if (peers.length === 0) return false
  const kind = target?.kind === 'group' ? 'group' : 'private'
  const peerId = String(target?.id ?? '').trim()
  if (peerId === '') return false
  return peers.some((peer) => peer.kind === kind && peer.id === peerId)
}

/** 某个 session 在 readers 表里订阅了哪些 peer。 */
export function readPeersOf(config, sessionId) {
  const id = String(sessionId ?? '').trim()
  const out = []
  if (id === '') return out
  for (const kind of KINDS) {
    const table = config?.readers?.[kind]
    if (table === null || typeof table !== 'object') continue
    for (const [peerId, list] of Object.entries(table)) {
      if (!Array.isArray(list)) continue
      if (list.some((reader) => sameSessionId(reader?.sessionId, id))) out.push({ kind, id: String(peerId) })
    }
  }
  return out
}

/**
 * 判断某个 session 是否有权读 target peer（Slice 4）。
 *
 * - 该 peer 的 writer 或 reader：有；
 * - 会话不在任何 routes / readers 里（独立会话）：保持旧行为 true，
 *   让 allowlist 那条旧闸门自己管（读历史不产生 QQ 侧副作用）；
 * - 有关系但目标不在关系里：false（读者不能借 qq_msg_history / qq_wait 偷看别的 peer）。
 */
export function canReadPeer(config, sessionId, target) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return true
  const kind = target?.kind === 'group' ? 'group' : 'private'
  const peerId = String(target?.id ?? '').trim()
  if (peerId === '') return false
  const writes = writerPeersOf(config, id)
  if (writes.some((peer) => peer.kind === kind && peer.id === peerId)) return true
  const reads = readPeersOf(config, id)
  if (reads.some((peer) => peer.kind === kind && peer.id === peerId)) return true
  return writes.length === 0 && reads.length === 0
}
