/**
 * sendapi.js —— AI 主动发消息的本地接口（给会话里的 AI 用，不需要 QQ 那边先开口）。
 *
 *   POST http://127.0.0.1:<sendApiPort>/send
 *   body: { "text": "要说的话", "user_id": "1000000004" }   // 不传 user_id 就发给默认私聊对象
 *   body: { "text": "群里说的话", "group_id": "2000000001" } // 传 group_id 发群
 *   GET  http://127.0.0.1:<sendApiPort>/health             // 看活着没
 *
 * 只绑 127.0.0.1，但这不等于安全：同机网页可发简单 POST。
 * 因此强制 Origin 只能是本机 / Content-Type 必须是 JSON / body 有上限；
 * 配置 sendApiToken 后还必须带 X-DSH-Send-Token。
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { getConfig } from './config.js'
import { note } from './env.js'
import { sendToQQ } from './outbound.js'
import { resolveFaceSegment } from './face-resolve.js'
import { findCustomFace } from './custom-faces.js'

export function startSendApi(stopFns) {
  const port = Number(getConfig().sendApiPort) || 39273
  const MAX_BODY = 64 * 1024
  const localOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const sameToken = (actual, expected) => {
    const a = Buffer.from(String(actual ?? ''))
    const b = Buffer.from(String(expected ?? ''))
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  let server
  try {
    server = createServer((req, res) => {
      void (async () => {
        const url = (req.url ?? '').split('?')[0]
        try {
          if (req.method === 'GET' && (url === '/' || url === '/health')) {
            const config = getConfig()
            return json(res, 200, { ok: true, enabled: config.enabled, selfUin: String(config.selfUin ?? '') })
          }
          if (req.method === 'POST' && url === '/send') {
            const origin = req.headers.origin
            // 浏览器跨站简单请求会带 Origin；只允许本机页面的 Origin，curl/本地脚本无 Origin。
            if (origin !== undefined && !localOrigins.has(String(origin))) {
              return json(res, 403, { ok: false, error: 'origin not allowed' })
            }
            const contentType = String(req.headers['content-type'] ?? '')
            if (!contentType.toLowerCase().startsWith('application/json')) {
              return json(res, 415, { ok: false, error: 'Content-Type must be application/json' })
            }
            const expectedToken = String(getConfig().sendApiToken ?? '')
            if (expectedToken !== '') {
              const supplied = String(req.headers['x-dsh-send-token'] ?? '').replace(/^Bearer\s+/i, '')
              if (!sameToken(supplied, expectedToken)) return json(res, 401, { ok: false, error: 'invalid send token' })
            }
            const chunks = []
            let size = 0
            for await (const chunk of req) {
              size += chunk.length
              if (size > MAX_BODY) return json(res, 413, { ok: false, error: 'body too large' })
              chunks.push(chunk)
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const text = String(body.text ?? '').trim()
            const emojiName = String(body.emoji ?? '').trim()
            const customEmojiName = String(body.custom_emoji ?? '').trim()
            if (text === '' && emojiName === '' && customEmojiName === '') {
              return json(res, 400, { ok: false, error: 'text 不能为空' })
            }
            const groupId = String(body.group_id ?? body.groupId ?? '').trim()
            const userId = String(body.user_id ?? body.userId ?? '').trim()
            // 群优先，跟 qq_send 一致
            const target = groupId !== ''
              ? { kind: 'group', id: groupId }
              : (userId !== '' ? { kind: 'private', id: userId } : { kind: 'private' })
            // 表情解析走 face-resolve（官方目录优先 + 有效性校验）。
            // 不能用 emoticons.faceSegmentOf —— 那张内置表有 109 个幽灵 id，
            // 拿幽灵 id 发会让协议端报错并把整条消息搞没。
            const faceSegment = emojiName !== '' ? await resolveFaceSegment(emojiName) : null
            let customEmojiId = ''
            if (customEmojiName !== '') {
              const found = await findCustomFace(customEmojiName)
              if (found === null) {
                return json(res, 400, { ok: false, error: `收藏夹里没找到含「${customEmojiName}」的表情` })
              }
              customEmojiId = found.emojiId
            }
            const result = await sendToQQ(target, text, { faceSegment, customEmojiId })
            note('sendapi', `sent ${groupId !== '' ? `group ${groupId}` : `private ${userId || 'default'}`} len=${text.length}${faceSegment !== null ? ' +face' : ''}${customEmojiId !== '' ? ' +custom' : ''}`)
            return json(res, 200, { ok: true, message_id: Number(result?.data?.message_id ?? 0) })
          }
          return json(res, 404, { ok: false, error: `unknown route: ${url}` })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          note('sendapi', `error ${message}`)
          return json(res, 500, { ok: false, error: message })
        }
      })()
    })
    server.on('error', (error) => {
      // 多实例抢端口是最常见的失败原因，不该连累收发主链路
      note('sendapi', `listen failed ${error instanceof Error ? error.message : error}`)
    })
    server.listen(port, '127.0.0.1', () => {
      note('sendapi', `AI 自动发消息接口已启动 http://127.0.0.1:${port}/send`)
    })
    if (Array.isArray(stopFns)) {
      stopFns.push(() => {
        try { server.close() } catch {}
      })
    }
  } catch (error) {
    note('sendapi', `start failed ${error instanceof Error ? error.message : error}`)
  }
}
