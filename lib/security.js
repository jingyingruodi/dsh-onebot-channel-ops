/**
 * security.js —— 提示词注入的最低限度护栏。
 *
 * QQ 消息是外部输入，不是系统/用户指令；但模型仍可能被其中一段话骗去改
 * 接收模式、改权限或给第三方发消息。这里做一个**可验证的硬闸**：
 *
 * - `deliver.js` / `backlog.js` 在把 QQ 消息投进某个会话时记录来源信任度；
 * - `qq_mute` / `qq_unmute` 改模式前检查：如果最近（默认 120 秒）刚投过
 *   **不可信来源**（群聊、非 owner 私聊、只读观察副本），直接拒绝，
 *   而不是指望模型自己拒绝。
 *
 * 这不是完整的提示词注入防御（开放发言/读消息后不存在绝对防御），
 * 但把「外部内容 → 立即改权限」这条最危险的路径从“靠模型自觉”改成“调用即拒绝”。
 * 人类在 DSH 界面里操作（右栏/设置页 API）不经过本模块，不受此限制。
 */
import { note } from './env.js'

/** 最近一次外部投递后，模式变更的冷却窗口。 */
export const MODE_CHANGE_GUARD_MS = 120 * 1000

const MAX_SESSIONS = 500
const inboundTrust = new Map()

function prune() {
  if (inboundTrust.size < MAX_SESSIONS) return
  const now = Date.now()
  for (const [sessionId, entry] of inboundTrust) {
    if (now - entry.at > MODE_CHANGE_GUARD_MS) inboundTrust.delete(sessionId)
  }
  if (inboundTrust.size >= MAX_SESSIONS) inboundTrust.clear()
}

/**
 * 记录一次投进会话的 QQ 消息来源。
 *
 * @param {string} sessionId
 * @param {{ trusted?: boolean, kind?: string, peerId?: string, sender?: string, at?: number }} [source]
 */
export function recordInboundTrust(sessionId, source = {}) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return
  prune()
  inboundTrust.set(id, {
    trusted: source.trusted === true,
    kind: String(source.kind ?? ''),
    peerId: String(source.peerId ?? ''),
    sender: String(source.sender ?? ''),
    at: Number.isFinite(source.at) ? Number(source.at) : Date.now()
  })
}

/** 最近一次投递来源（诊断/测试用）。 */
export function lastInboundTrust(sessionId) {
  const entry = inboundTrust.get(String(sessionId ?? '').trim())
  return entry === undefined ? null : { ...entry }
}

/**
 * 模式变更硬闸：最近一次投递来自不可信来源且仍在冷却窗口内 → 拒绝。
 *
 * 没有来源记录（例如用户刚在 DSH 界面发消息）时放行，避免把人机操作也锁死；
 * 真正的连续威胁由「每次 QQ 投递都会先记录来源」覆盖。
 *
 * @param {string} sessionId
 */
export function assertModeChangeAllowed(sessionId) {
  const id = String(sessionId ?? '').trim()
  const last = inboundTrust.get(id)
  if (last === undefined || last.trusted === true) return
  const age = Date.now() - last.at
  if (age > MODE_CHANGE_GUARD_MS) return
  note('security', `模式变更被护栏拒绝 session=${id} source=${last.kind}:${last.peerId} sender=${last.sender} age=${age}ms`)
  throw new Error(
    '安全护栏：最近的 QQ 消息来自外部/群聊/只读副本，不能根据它修改接收模式。'
    + '请让用户在 DSH 界面明确操作；若确实要由会话自己改，等外部消息冷却后再发起。'
  )
}

/** 仅测试：清空来源记录。 */
export function resetInboundTrustForTest() {
  inboundTrust.clear()
}
