/**
 * schedule.js —— 定时接收模式（acceptance schedules）。
 *
 * 设计：配置里保存「周几 + HH:MM + target + set/restore」；运行时把快照放在
 * state.scheduleSnapshots，把已执行键放在 state.scheduleRuns，重启不重复执行。
 *
 * 只做 writer 路由的 wakeMode；reader 的调度需要显式 readerSessionId，
 * 本模块不碰 reader，避免只读会话改 writer。
 */
import { note } from './env.js'
import { WAKE_MODES } from './policy.js'

export const SCHEDULE_MAX = 64
export const SNAPSHOT_MAX = 20
export const SCHEDULE_INTERVAL_MS = 20 * 1000
/** 停机补恢复只处理最近 24h 内错过的 restore，避免把很久以前的旧快照复活。 */
export const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const formatterCache = new Map()

function text(value, max = 80) {
  return String(value ?? '').trim().slice(0, max)
}

function normalizeTime(value) {
  const raw = String(value ?? '').trim()
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw)
  return match === null ? '' : `${match[1]}:${match[2]}`
}

function normalizeMode(value) {
  return WAKE_MODES.includes(value) ? value : ''
}

/**
 * 把配置里的 acceptanceSchedules 规整成安全、可预测的结构。
 * 非法条目直接丢弃；同一个 id 只保留第一条。
 *
 * @param {unknown} raw
 * @returns {Array<object>}
 */
export function normalizeSchedules(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (out.length >= SCHEDULE_MAX) break
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const id = text(item.id, 80)
    if (id === '' || seen.has(id)) continue
    const weekdays = [...new Set((Array.isArray(item.weekdays) ? item.weekdays : [])
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b)
    const time = normalizeTime(item.time)
    const target = item.target !== null && typeof item.target === 'object' ? item.target : {}
    const kind = target.kind === 'group' || target.kind === 'private' ? target.kind : ''
    const targetId = text(target.id ?? target.peerId, 80)
    if (weekdays.length === 0 || time === '' || kind === '' || targetId === '' || DANGEROUS_KEYS.has(targetId)) continue
    const action = item.action !== null && typeof item.action === 'object' ? item.action : {}
    const type = action.type === 'restore' ? 'restore' : action.type === 'set' ? 'set' : ''
    if (type === '') continue
    const mode = normalizeMode(action.mode)
    const fallbackMode = normalizeMode(action.fallbackMode)
    // 定时 set 不允许 off：DSH 重启/停机错过 restore 时 off 会静默丢消息；
    // 需要 off 时请手工用 qq_mute，并由用户自己负责恢复。
    if (type === 'set' && (mode === '' || mode === 'off')) continue
    if (type === 'restore' && (fallbackMode === '' || fallbackMode === 'off')) continue
    const timezone = text(item.timezone ?? DEFAULT_TIMEZONE, 64) || DEFAULT_TIMEZONE
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    } catch {
      continue
    }
    seen.add(id)
    out.push({
      id,
      name: text(item.name, 80) || id,
      enabled: item.enabled !== false,
      weekdays,
      time,
      timezone,
      target: { kind, id: targetId },
      action: {
        type,
        mode,
        fallbackMode,
        captureBefore: type === 'set' ? action.captureBefore !== false : false,
        onlyIfUnchanged: type === 'restore' ? action.onlyIfUnchanged !== false : false
      }
    })
  }
  return out
}

function formatterFor(timezone) {
  const key = String(timezone ?? DEFAULT_TIMEZONE)
  let formatter = formatterCache.get(key)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23'
    })
    formatterCache.set(key, formatter)
  }
  return formatter
}

function partsAt(now, timezone) {
  const formatter = formatterFor(timezone)
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  const weekday = WEEKDAYS.indexOf(parts.weekday) + 1
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday }
}

/** 该 schedule 在 now 这一分钟是否应当执行。 */
export function scheduleDue(schedule, now = new Date()) {
  if (schedule === null || typeof schedule !== 'object' || schedule.enabled === false) return false
  let local
  try {
    local = partsAt(now, schedule.timezone ?? DEFAULT_TIMEZONE)
  } catch {
    return false
  }
  return schedule.weekdays.includes(local.weekday) && local.time === schedule.time
}

/** 幂等键：本地日期 + 时间 + schedule id。 */
export function scheduleRunKey(schedule, now = new Date()) {
  const local = partsAt(now, schedule.timezone ?? DEFAULT_TIMEZONE)
  return `${local.date}|${local.time}|${schedule.id}`
}

function targetKey(target) {
  return `${target.kind}:${target.id}`
}

function sameTarget(a, b) {
  return a?.kind === b?.kind && String(a?.id ?? '') === String(b?.id ?? '')
}

function targetFromKey(key) {
  const index = String(key).indexOf(':')
  if (index <= 0) return null
  return { kind: key.slice(0, index), id: key.slice(index + 1) }
}

/**
 * 找 after 之后最近一次 restore 计划。最多看 8 天，足够覆盖周计划。
 * 返回 { at: Date, scheduleId } 或 null。
 */
function nextRestoreAt(schedules, target, after) {
  // 对齐到下一分钟：restoreAt 不应带 set 时刻的秒/毫秒，否则日志会显示
  // 「错过 21:53:12」但实际只是同一分钟的第 12 秒。
  const startMs = Math.ceil((after.getTime() + 1) / (60 * 1000)) * 60 * 1000
  for (let offset = 0; offset < 8 * 24 * 60; offset += 1) {
    const at = new Date(startMs + offset * 60 * 1000)
    for (const schedule of schedules) {
      if (schedule.action.type !== 'restore' || !sameTarget(schedule.target, target)) continue
      if (scheduleDue(schedule, at)) return { at, scheduleId: schedule.id }
    }
  }
  return null
}

function routeFor(config, target) {
  const table = config?.routes?.[target.kind]
  if (table === null || typeof table !== 'object') return null
  const route = table[target.id]
  return route !== null && typeof route === 'object' ? route : null
}

function pushSnapshot(state, target, snapshot) {
  if (state.scheduleSnapshots === null || typeof state.scheduleSnapshots !== 'object') state.scheduleSnapshots = {}
  const key = targetKey(target)
  const stack = Array.isArray(state.scheduleSnapshots[key]) ? state.scheduleSnapshots[key] : []
  stack.push(snapshot)
  if (stack.length > SNAPSHOT_MAX) stack.splice(0, stack.length - SNAPSHOT_MAX)
  state.scheduleSnapshots[key] = stack
}

function peekSnapshot(state, target) {
  const key = targetKey(target)
  const stack = Array.isArray(state.scheduleSnapshots?.[key]) ? state.scheduleSnapshots[key] : []
  return stack.length === 0 ? null : stack[stack.length - 1]
}

function popSnapshot(state, target) {
  const key = targetKey(target)
  const stack = Array.isArray(state.scheduleSnapshots?.[key]) ? state.scheduleSnapshots[key] : []
  return stack.length === 0 ? undefined : stack.pop()
}

function retireSnapshot(state, target, restoreSchedule, restoreAt) {
  popSnapshot(state, target)
  if (restoreSchedule !== null && restoreAt instanceof Date && Number.isFinite(restoreAt.getTime())) {
    state.scheduleRuns[scheduleRunKey(restoreSchedule, restoreAt)] = new Date().toISOString()
  }
  return true
}

function cleanupRuns(state) {
  if (state.scheduleRuns === null || typeof state.scheduleRuns !== 'object') {
    state.scheduleRuns = {}
    return
  }
  const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  for (const key of Object.keys(state.scheduleRuns)) {
    if (key.slice(0, 10) < cutoff) delete state.scheduleRuns[key]
  }
}

/**
 * 停机/重启错过 restore 时，按快照里的 restoreAt 补恢复。
 *
 * 只在 restoreAt 已经过去、且当前仍是 setMode 时恢复；onlyIfUnchanged
 * 仍然生效。已在到期分钟执行过的 restore 不走这里，避免和 applyDueSchedules 重复。
 */
function reconcileMissedRestores({ config, state, schedules, now }) {
  const changes = []
  let dirty = false
  const table = state.scheduleSnapshots
  if (table === null || typeof table !== 'object') return { changes, dirty }
  for (const [key, stack] of Object.entries(table)) {
    if (!Array.isArray(stack) || stack.length === 0) continue
    const snapshot = stack[stack.length - 1]
    if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.restoreAt !== 'string') continue
    const restoreAt = new Date(snapshot.restoreAt)
    if (!Number.isFinite(restoreAt.getTime()) || now.getTime() - restoreAt.getTime() < 60 * 1000) continue
    const target = snapshot.target ?? targetFromKey(key)
    if (target === null || (target.kind !== 'group' && target.kind !== 'private') || DANGEROUS_KEYS.has(String(target.id ?? ''))) continue
    const route = routeFor(config, target)
    if (route === null) continue
    const current = WAKE_MODES.includes(route.wakeMode) ? route.wakeMode : 'wake'
    const restoreSchedule = schedules.find((schedule) => schedule.id === snapshot.restoreScheduleId) ?? null
    // 计划被删除/停用：尊重用户的显式操作，不再补恢复。
    if (restoreSchedule === null || restoreSchedule.enabled === false) {
      dirty = retireSnapshot(state, target, restoreSchedule, restoreAt) || dirty
      note('schedule', `退休快照 ${key}：restore 计划不存在或已停用`)
      continue
    }
    // 计划时间被改过：按新时间更新快照，不在旧时间误恢复。
    const scheduleAfterSet = new Date(String(snapshot.at ?? ''))
    const next = Number.isFinite(scheduleAfterSet.getTime())
      ? nextRestoreAt(schedules, target, scheduleAfterSet)
      : null
    if (next === null) {
      dirty = retireSnapshot(state, target, restoreSchedule, restoreAt) || dirty
      note('schedule', `退休快照 ${key}：找不到下一次 restore`)
      continue
    }
    if (Math.abs(next.at.getTime() - restoreAt.getTime()) > 60 * 1000 || next.scheduleId !== snapshot.restoreScheduleId) {
      snapshot.restoreAt = next.at.toISOString()
      snapshot.restoreScheduleId = next.scheduleId
      dirty = true
      continue
    }
    // 超过 24h：如果当前仍是 setMode，恢复到变更前模式并退休，避免陈旧 muted
    // 被下一次 set 记成 previousMode，造成永久静音。
    if (now.getTime() - restoreAt.getTime() > RECONCILE_WINDOW_MS) {
      if (current === snapshot.setMode && WAKE_MODES.includes(snapshot.previousMode)) {
        route.wakeMode = snapshot.previousMode
        changes.push({
          scheduleId: restoreSchedule.id,
          target: { ...target },
          type: 'expire',
          previousMode: current,
          mode: snapshot.previousMode
        })
        note('schedule', `过期补恢复 ${key} ${current} -> ${snapshot.previousMode}（错过超过 24h）`)
      } else {
        note('schedule', `退休过期快照 ${key}：错过超过 24h，当前 ${current} 不覆盖`)
      }
      dirty = retireSnapshot(state, target, restoreSchedule, restoreAt) || dirty
      continue
    }
    const onlyIfUnchanged = restoreSchedule.action.onlyIfUnchanged
    if (onlyIfUnchanged && current !== snapshot.setMode) {
      dirty = retireSnapshot(state, target, restoreSchedule, restoreAt) || dirty
      note('schedule', `退休快照 ${key}：当前 ${current} 已被手动改，不覆盖`)
      continue
    }
    if (!WAKE_MODES.includes(snapshot.previousMode)) {
      dirty = retireSnapshot(state, target, restoreSchedule, restoreAt) || dirty
      continue
    }
    route.wakeMode = snapshot.previousMode
    popSnapshot(state, target)
    dirty = true
    if (restoreSchedule !== null) {
      const runKey = scheduleRunKey(restoreSchedule, restoreAt)
      state.scheduleRuns[runKey] = new Date().toISOString()
    }
    changes.push({
      scheduleId: restoreSchedule?.id ?? snapshot.scheduleId,
      target: { ...target },
      type: 'reconcile',
      previousMode: current,
      mode: snapshot.previousMode
    })
    note('schedule', `补恢复 ${key} ${current} -> ${snapshot.previousMode}（错过 ${snapshot.restoreAt}）`)
  }
  return { changes, dirty }
}

/**
 * 执行当前这一分钟所有到期 schedule.
 *
 * 纯副作用集中在这里，便于测试；调用方负责把 config/state 落盘。
 *
 * @param {object} input
 * @param {object} input.config
 * @param {object} input.state
 * @param {Date} [input.now]
 * @returns {{changes: Array<object>, ran: boolean}}
 */
export function applyDueSchedules({ config, state, now = new Date() }) {
  const schedules = normalizeSchedules(config?.acceptanceSchedules)
    .sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
  if (state.scheduleRuns === null || typeof state.scheduleRuns !== 'object') state.scheduleRuns = {}
  if (state.scheduleSnapshots === null || typeof state.scheduleSnapshots !== 'object') state.scheduleSnapshots = {}
  const reconciled = reconcileMissedRestores({ config, state, schedules, now })
  const changes = reconciled.changes
  let ran = changes.length > 0 || reconciled.dirty
  for (const schedule of schedules) {
    if (!scheduleDue(schedule, now)) continue
    const runKey = scheduleRunKey(schedule, now)
    if (state.scheduleRuns[runKey] !== undefined) continue
    state.scheduleRuns[runKey] = new Date().toISOString()
    ran = true
    const route = routeFor(config, schedule.target)
    if (route === null) {
      note('schedule', `跳过 ${schedule.id}：目标 ${targetKey(schedule.target)} 不在 routes 中`)
      continue
    }
    const previousMode = WAKE_MODES.includes(route.wakeMode) ? route.wakeMode : 'wake'
    let nextMode = ''
    if (schedule.action.type === 'set') {
      nextMode = schedule.action.mode
      if (schedule.action.captureBefore) {
        const restore = nextRestoreAt(schedules, schedule.target, now)
        pushSnapshot(state, schedule.target, {
          scheduleId: schedule.id,
          previousMode,
          setMode: nextMode,
          at: now.toISOString(),
          restoreAt: restore === null ? null : restore.at.toISOString(),
          restoreScheduleId: restore === null ? '' : restore.scheduleId,
          target: { ...schedule.target }
        })
      }
    } else {
      const snapshot = peekSnapshot(state, schedule.target)
      if (snapshot !== null) {
        if (schedule.action.onlyIfUnchanged && previousMode !== snapshot.setMode) {
          note('schedule', `跳过 ${schedule.id}：${targetKey(schedule.target)} 当前 ${previousMode}，快照 setMode=${snapshot.setMode}`)
          continue
        }
        popSnapshot(state, schedule.target)
        nextMode = snapshot.previousMode
      } else {
        nextMode = schedule.action.fallbackMode
      }
    }
    if (!WAKE_MODES.includes(nextMode)) {
      note('schedule', `跳过 ${schedule.id}：没有可恢复模式`)
      continue
    }
    route.wakeMode = nextMode
    changes.push({
      scheduleId: schedule.id,
      target: { ...schedule.target },
      type: schedule.action.type,
      previousMode,
      mode: nextMode
    })
    note('schedule', `${schedule.id} ${schedule.action.type} ${targetKey(schedule.target)} ${previousMode} -> ${nextMode}`)
  }
  cleanupRuns(state)
  return { changes, ran }
}

/**
 * 启动分钟级调度。dispose 时必须停止，避免插件重载泄漏定时器。
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {() => object} deps.getState
 * @param {() => boolean} deps.saveConfig
 * @param {(patch: object) => void} deps.saveState
 * @returns {() => void}
 */
export function startAcceptanceScheduler(ctx, { getConfig, getState, saveConfig, saveState }) {
  const tick = () => {
    try {
      const config = getConfig()
      const state = getState()
      const beforeConfig = JSON.parse(JSON.stringify(config))
      const beforeState = JSON.parse(JSON.stringify(state))
      const restoreMemory = () => {
        Object.assign(config, beforeConfig)
        Object.assign(state, beforeState)
      }
      const { changes, ran } = applyDueSchedules({ config, state })
      if (changes.length === 0) {
        if (ran) saveState({ scheduleRuns: state.scheduleRuns, scheduleSnapshots: state.scheduleSnapshots })
        return
      }
      // 先写 state（快照+runKey），再写 config；config 失败时回滚 state，
      // 保证重启后不会被 runKey 挡掉这次未落盘的模式变更。
      if (saveState({ scheduleRuns: state.scheduleRuns, scheduleSnapshots: state.scheduleSnapshots }) !== true) {
        note('schedule', 'state 落盘失败，回滚本次变更')
        restoreMemory()
        return
      }
      if (saveConfig() !== true) {
        note('schedule', '配置落盘失败，回滚 state/config 并等待下一轮重试')
        restoreMemory()
        if (saveState({ scheduleRuns: beforeState.scheduleRuns ?? {}, scheduleSnapshots: beforeState.scheduleSnapshots ?? {} }) !== true) {
          note('schedule', 'state 回滚失败')
        }
        return
      }
    } catch (error) {
      note('schedule', `tick failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  const timer = setInterval(tick, SCHEDULE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  tick()
  note('schedule', `started interval=${SCHEDULE_INTERVAL_MS}ms`)
  return () => {
    clearInterval(timer)
    note('schedule', 'stopped')
  }
}
