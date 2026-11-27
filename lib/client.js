/**
 * dsh-onebot-channel —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 注册「QQ 桥接」设置页（slot: settings.section）：
 *   - 每个 QQ 好友 / 群 → 绑定一个 DSH 会话 + 可选的正文前缀；
 *   - 没绑定的号发来的消息一律忽略（不发散、不兜底）；
 *   - 对话节奏（沉默权）、关系记忆、推送链路、高级参数都在这一页里调；
 *   - 「审查隔离」分区给 owner 查看被消息准入审查拦下的原文，并放行/忽略。
 *
 * 与宿主只走同源 HTTP（/api/qq-bridge/*），不碰 RPC。
 * 改完用 node --check lib/client.js 验语法（它是表达式，check 只验语法不执行）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-onebot-channel',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/api/qq-bridge'

    // ---- 同源 API ---------------------------------------------------------

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function readJson(response) {
      return response.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (error) {
          throw new Error('接口返回的不是 JSON：' + text.slice(0, 120))
        }
        if (response.ok !== true) {
          var failure = new Error((data && data.error) || 'HTTP ' + response.status)
          // 保存冲突（409）要单独处理：让面板重新载入，而不是当成普通失败
          failure.status = response.status
          failure.data = data
          throw failure
        }
        return data
      })
    }

    /** 数字字段：0 是合法值，只有缺失/非数字才用默认值（与后端 numOr 同语义）。 */
    function numOr(value, fallback) {
      if (value === null || value === undefined || value === '') return fallback
      var number = Number(value)
      return Number.isFinite(number) ? number : fallback
    }

    /** 消息审查白名单：条目格式与上限跟 lib/api.js 的校验保持一致。 */
    var REVIEW_WHITELIST_ENTRY = /^(?:user|group):\d{1,20}$/
    var REVIEW_WHITELIST_ENTRY_MAX = 64
    var REVIEW_WHITELIST_MAX_ITEMS = 200

    /**
     * 把多行 / 逗号分隔的白名单文本解析成字符串数组。
     * 空文本是合法值（= 谁都不豁免）；解析失败时 error 非空，调用方不应提交。
     * @param {string} text 输入框里的原始文本
     * @returns {{list: string[], error: string}}
     */
    function parseReviewWhitelist(text) {
      var parts = String(text === null || text === undefined ? '' : text).split(/[\n\r,，;；]+/)
      var list = []
      var count = 0
      for (var i = 0; i < parts.length; i++) {
        var entry = String(parts[i] || '').trim()
        if (entry === '') continue
        count += 1
        if (entry.length > REVIEW_WHITELIST_ENTRY_MAX) {
          return { list: [], error: '第 ' + String(count) + ' 条太长（单条上限 ' + String(REVIEW_WHITELIST_ENTRY_MAX) + ' 个字符）' }
        }
        if (REVIEW_WHITELIST_ENTRY.test(entry) !== true) {
          return { list: [], error: '第 ' + String(count) + ' 条格式不对：' + entry + '（要写成 user:<QQ号> 或 group:<群号>，只含数字）' }
        }
        if (list.indexOf(entry) < 0) list.push(entry)
      }
      if (list.length > REVIEW_WHITELIST_MAX_ITEMS) {
        return { list: [], error: '最多 ' + String(REVIEW_WHITELIST_MAX_ITEMS) + ' 条，现在有 ' + String(list.length) + ' 条' }
      }
      return { list: list, error: '' }
    }

    function errText(error) {
      return error && error.message ? error.message : String(error)
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.qqb-wrap{display:flex;flex-direction:column;gap:16px;padding:4px 2px;font-size:13px;}',
      '.qqb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.qqb-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-desc{color:var(--dsw-alias-label-secondary,#5b6270);line-height:1.65;}',
      '.qqb-card{border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden;}',
      '.qqb-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,#f6f7f9);border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6eb);}',
      '.qqb-card-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-row{display:grid;grid-template-columns:118px 1fr 200px 118px auto;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
      '.qqb-row:last-child{border-bottom:0;}',
      '.qqb-empty{padding:14px 12px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.qqb-uin{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-name{color:var(--dsw-alias-label-secondary,#5b6270);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.qqb-input,.qqb-select{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d0d4da);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;}',
      '.qqb-btn{padding:5px 11px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d0d4da);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;font-size:12px;white-space:nowrap;}',
      '.qqb-btn:hover{background:var(--dsw-alias-bg-layer-2,#f2f4f7);}',
      '.qqb-btn.primary{background:var(--dsw-alias-brand-primary,#2f6feb);border-color:var(--dsw-alias-brand-primary,#2f6feb);color:#fff;}',
      '.qqb-btn.primary:disabled{opacity:.55;cursor:default;}',
      '.qqb-btn.danger{color:var(--dsw-alias-state-error-primary,#c9302c);}',
      '.qqb-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1,#eef0f3);background:var(--dsw-alias-bg-layer-2,#f6f7f9);}',
      '.qqb-msg{font-size:12px;}',
      '.qqb-msg.ok{color:var(--dsw-alias-state-success-primary,#1a7f37);}',
      '.qqb-msg.err{color:var(--dsw-alias-state-error-primary,#c9302c);}',
      '.qqb-note{color:var(--dsw-alias-label-tertiary,#8a909c);font-size:12px;line-height:1.6;}',
      '.qqb-err{color:var(--dsw-alias-state-error-primary,#c9302c);white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:12px;}',
      '.qqb-adv{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px 20px;padding:12px;}',
      '.qqb-field{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.qqb-field-label{flex:0 0 112px;color:var(--dsw-alias-label-secondary,#5b6270);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.qqb-num{width:82px;flex:0 0 auto;}',
      '.qqb-unit{color:var(--dsw-alias-label-tertiary,#8a909c);font-size:12px;}',
      '.qqb-check{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.qqb-wide{grid-column:1 / -1;}',
      '.qqb-field.wide{align-items:flex-start;}',
      '.qqb-field.wide .qqb-field-label{padding-top:5px;}',
      '.qqb-field.wide .qqb-input{flex:1 1 auto;width:auto;min-width:0;}',
      '.qqb-textarea{width:100%;min-height:64px;resize:vertical;line-height:1.55;font-family:ui-monospace,Consolas,monospace;}',
      '.qqb-hint-inline{color:var(--dsw-alias-label-tertiary,#8a909c);font-size:12px;}',
      '.qqb-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.qqb-self{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);background:var(--dsw-alias-bg-layer-2,#f6f7f9);}',
      '.qqb-self-uin{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-self-name{color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.qqb-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#c9302c);display:inline-block;flex:0 0 auto;}',
      '.qqb-self.on .qqb-dot{background:var(--dsw-alias-state-success-primary,#1a7f37);}',
      '.qqb-warn{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-warning-primary,#b8860b);background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#1f2328);line-height:1.6;}',
      '.qqb-mem{display:flex;flex-direction:column;gap:4px;padding:10px 12px;}',
      '.qqb-mem-row{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.6;}',
      '.qqb-mem-key{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#1f2328);flex:0 0 auto;}',
      '.qqb-sec-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);padding:10px 12px 0;}',
      // 0.9.1：功能分区导航 —— 卡片一多就变成一堵墙，改成「上面列功能、点进去只看到那一块」
      '.qqb-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6eb);padding:0 2px;background:transparent;}',
      '.qqb-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5b6270);font-size:12.5px;font-family:inherit;padding:8px 12px 9px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;border-radius:6px 6px 0 0;}',
      '.qqb-tab:hover{background:var(--dsw-alias-bg-layer-2,#f2f4f7);color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-tab.on{color:var(--dsw-alias-label-primary,#1f2328);border-bottom-color:var(--dsw-alias-brand-primary,#2f6feb);font-weight:600;}',
      '.qqb-tab-badge{margin-left:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.qqb-pane{display:flex;flex-direction:column;gap:12px;}',
      '.qqb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;}',
      '.qqb-stat{border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:3px;}',
      '.qqb-stat-n{font-size:19px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);font-variant-numeric:tabular-nums;}',
      '.qqb-stat-l{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.qqb-stat.on{border-color:var(--dsw-alias-brand-primary,#2f6feb);}',
      '.qqb-tgt-row{display:grid;grid-template-columns:auto 110px 1fr auto;gap:8px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
      '.qqb-tgt-row:last-child{border-bottom:0;}',
      '.qqb-tgt-main{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.qqb-mode{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:10px 12px 0;}',
      // Slice 3：读者分区。一行一个 peer，下面缩进挂它的读者行。
      '.qqb-reader-peer{display:flex;flex-direction:column;gap:6px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
      '.qqb-reader-peer:last-child{border-bottom:0;}',
      '.qqb-reader-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.qqb-reader-row{display:grid;grid-template-columns:minmax(160px,1fr) 168px 96px auto;gap:8px;align-items:center;padding-left:14px;}',
      '.qqb-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);background:var(--dsw-alias-bg-layer-2,#f6f7f9);font-size:11px;color:var(--dsw-alias-label-secondary,#5b6270);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.qqb-tag.warn{color:var(--dsw-alias-state-warning-primary,#b8860b);border-color:var(--dsw-alias-state-warning-primary,#b8860b);}',
      // 右侧边栏 QQ 权限页
      '.qqb-perm-sec{display:flex;flex-direction:column;gap:0;}',
      '.qqb-perm-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
      '.qqb-perm-row:last-child{border-bottom:0;}',
      '.qqb-perm-main{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.qqb-perm-id{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;}',
      '.qqb-perm-sub{color:var(--dsw-alias-label-tertiary,#8a909c);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.qqb-perm-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;}',
      '.qqb-perm-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;}',
      '.qqb-perm-form .qqb-input{flex:1 1 110px;min-width:90px;}',
      '.qqb-perm-form .qqb-select{flex:0 0 auto;}',
      '.qqb-perm-empty{padding:10px 12px;color:var(--dsw-alias-label-tertiary,#8a909c);font-size:12px;}',
      '.qqb-perm-note{padding:8px 12px;color:var(--dsw-alias-label-tertiary,#8a909c);font-size:11px;line-height:1.6;border-top:1px solid var(--dsw-alias-border-l1,#eef0f3);}',
      // 消息准入审查隔离区（owner 侧）
      '.qqb-qn-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);background:var(--dsw-alias-bg-layer-2,#f6f7f9);}',
      '.qqb-qn-toolbar .qqb-field{flex:0 0 auto;}',
      '.qqb-qn-toolbar .qqb-field-label{flex:0 0 auto;}',
      '.qqb-qn-toolbar .qqb-select{width:auto;min-width:78px;}',
      '.qqb-qn-list{display:flex;flex-direction:column;gap:10px;padding:12px;}',
      '.qqb-qn-item{border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:7px;}',
      '.qqb-qn-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.qqb-qn-verdict{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.qqb-qn-verdict.block{color:var(--dsw-alias-state-error-primary,#c9302c);border-color:var(--dsw-alias-state-error-primary,#c9302c);}',
      '.qqb-qn-verdict.suspect{color:var(--dsw-alias-state-warning-primary,#b8860b);border-color:var(--dsw-alias-state-warning-primary,#b8860b);}',
      '.qqb-qn-sub{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.qqb-qn-reason{white-space:pre-wrap;word-break:break-word;line-height:1.6;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-qn-raw summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#5b6270);font-size:12px;}',
      '.qqb-qn-raw pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-primary,#1f2328);font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;}',
      '.qqb-qn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.qqb-qn-confirm{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border-radius:6px;border:1px solid var(--dsw-alias-state-warning-primary,#b8860b);background:var(--dsw-alias-bg-layer-2,#f6f7f9);}',
      '.qqb-qn-confirm-q{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.qqb-qn-confirm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.qqb-qn-notices{display:flex;flex-direction:column;gap:3px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);background:var(--dsw-alias-bg-layer-2,#f6f7f9);}',
    ].join('\n')

    function ensureStyles() {
      var id = 'dsh-onebot-channel-style'
      if (document.getElementById(id) !== null) return
      var el = document.createElement('style')
      el.id = id
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ---- 错误边界：设置页崩了要看得见原因，不能整块白屏 ---------------------
    //
    // 必须用 class + getDerivedStateFromError。函数组件里 throw 是接不住的，
    // 异常会一路冒到最外层，整个设置面板直接消失（之前就是这么白屏的）。

    class SectionErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      render() {
        var error = this.state.error
        if (error !== null && error !== undefined) {
          var detail = String(error && error.message ? error.message : error)
          return h('div', { className: 'qqb-wrap' }, [
            h('div', { className: 'qqb-title', key: 't' }, 'QQ 桥接：页面渲染出错'),
            h('div', { className: 'qqb-err', key: 'e' }, detail),
            h('div', { className: 'qqb-note', key: 'n' }, '完整堆栈看 DSH 的开发者工具控制台；也可以直接把这句话发给小薇。'),
          ])
        }
        return this.props.children
      }
    }

    // ---- 设置页主体 -------------------------------------------------------

    /** 路径比较用：大小写、斜杠方向、结尾斜杠都可能不一致，先归一化再比。 */
    function normCwd(value) {
      return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /**
     * 浏览器端的会话列表：比宿主端全（含没打开的会话），而且带 displayTitle。
     * 拿不到就返回空数组，退回宿主端那份，别让设置页崩。
     */
    function clientSessions(ctx, wantCwd) {
      try {
        var store = ctx && ctx.sessions ? ctx.sessions.list : null
        if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return []
        var snap = store.getSnapshot()
        var byId = (snap && snap.byId) || {}
        var want = normCwd(wantCwd)
        var out = []
        for (var key in byId) {
          if (Object.prototype.hasOwnProperty.call(byId, key) !== true) continue
          var item = byId[key]
          if (item === null || item === undefined) continue
          var cwd = String(item.cwd || '')
          if (want !== '' && cwd !== '' && normCwd(cwd) !== want) continue
          out.push({
            id: String(item.id || key),
            title: String(item.displayTitle || item.title || '').trim(),
            cwd: cwd,
            updatedAt: String(item.updatedAt || ''),
          })
        }
        return out
      } catch (error) {
        return []
      }
    }

    /** 合并宿主端和浏览器端两份会话列表：id 去重，标题留有的，时间留新的。 */
    function mergeSessions(serverList, clientList) {
      var byId = {}
      var order = []

      function put(item) {
        if (item === null || item === undefined) return
        var id = String(item.id || '').trim()
        if (id === '') return
        var title = String(item.title || '').trim()
        var updatedAt = String(item.updatedAt || '')
        var old = byId[id]
        if (old === undefined) {
          byId[id] = { id: id, title: title, cwd: String(item.cwd || ''), updatedAt: updatedAt }
          order.push(id)
          return
        }
        if (title !== '') old.title = title
        if (updatedAt > old.updatedAt) old.updatedAt = updatedAt
        if (old.cwd === '') old.cwd = String(item.cwd || '')
      }

      ;(serverList || []).forEach(put)
      ;(clientList || []).forEach(put)
      var out = order.map(function (id) { return byId[id] })
      // 空壳会话排到最后（前缀跟 index.js 里保持一致）
      function rank(item) { return item.title.indexOf('（空会话') === 0 ? 1 : 0 }
      out.sort(function (a, b) {
        if (rank(a) !== rank(b)) return rank(a) - rank(b)
        return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
      })
      return out
    }

    function sessionLabel(session) {
      var title = String(session.title || '').trim()
      if (title !== '') return title
      // 没标题（新会话还没消息）时，别拿带 session- 前缀的 id 截前 8 位——那只会显示 "session-"
      var bare = String(session.id || '').replace(/^session-/, '')
      var stamp = String(session.updatedAt || '')
      var time = stamp.length >= 16 ? ' · ' + stamp.slice(5, 16).replace('T', ' ') : ''
      return '#' + bare.slice(0, 8) + time
    }

    /** 头部那枚「当前接入的 QQ」徽章：绿点=链路通，红点=连不上。 */
    function selfBadge(self) {
      if (self === null || self === undefined || String(self.uin || '') === '') {
        return h('span', { className: 'qqb-self', key: 'self' }, [
          h('span', { className: 'qqb-dot', key: 'd' }),
          h('span', { key: 'x' }, '未连接 / 未登录'),
        ])
      }
      var name = String(self.name || '')
      return h('span', { className: 'qqb-self on', key: 'self' }, [
        h('span', { className: 'qqb-dot', key: 'd' }),
        h('span', { className: 'qqb-self-uin', key: 'u' }, String(self.uin)),
        name === '' ? null : h('span', { className: 'qqb-self-name', key: 'n' }, '「' + name + '」'),
      ])
    }

    /** WS 推送状态徽章：绿点=已连上（实时），灰点=没连（走轮询兜底）。 */
    function wsBadge(ws) {
      if (ws === null || ws === undefined) return null
      var on = ws.connected === true
      var text = on
        ? '推送已连（实时）'
        : (ws.lastError ? '推送断开（轮询兜底）' : '推送未连（轮询兜底）')
      return h('span', { className: 'qqb-self' + (on ? ' on' : ''), key: 'ws' }, [
        h('span', { className: 'qqb-dot', key: 'd' }),
        h('span', { className: 'qqb-self-name', key: 'n' }, text),
      ])
    }

    /** 读者表的可编辑草稿：深拷贝，改草稿不能顺手改掉 /state 拿到的数据。 */
    function cloneReaders(raw) {
      var out = { private: {}, group: {} }
      if (raw === null || raw === undefined || typeof raw !== 'object') return out
      ;['private', 'group'].forEach(function (kind) {
        var table = raw[kind]
        if (table === null || table === undefined || typeof table !== 'object') return
        for (var peerId in table) {
          if (Object.prototype.hasOwnProperty.call(table, peerId) !== true) continue
          var list = Array.isArray(table[peerId]) ? table[peerId] : []
          out[kind][String(peerId)] = list.map(function (item) {
            var mode = String(item && item.wakeMode ? item.wakeMode : 'muted')
            // 宿主返回的非法模式（手改配置/旧版本）不要原样塞进受控 select：
            // value 不在 options 里时浏览器会显示空白，用户也改不回来。
            if (['wake', 'backlog', 'muted', 'off'].indexOf(mode) < 0) mode = 'muted'
            return {
              sessionId: String(item && item.sessionId ? item.sessionId : '').slice(0, 200),
              // 后端没给模式时按 muted 处理：新读者默认不唤醒
              wakeMode: mode,
              autoReply: 'off',
              read: true,
              write: false,
              backlogMaxMessages: numOr(item && item.backlogMaxMessages, 50),
              backlogMaxChars: numOr(item && item.backlogMaxChars, 20000),
            }
          }).filter(function (item) { return item.sessionId !== '' })
        }
      })
      return out
    }

    /** 读者的四种投递模式；ambient 仅支持 writer，reader 暂不提供。 */
    var READER_MODES = [
      ['wake', '唤醒', '收到就投进会话'],
      ['backlog', '积压', '入队，下次进会话自动读'],
      ['muted', '免打扰', '入队，手动 qq_read 才读'],
      ['off', '关闭', '不投也不入队'],
    ]

    /**
     * 设置页的功能分区（0.9.1）。
     * 卡片一多，竖着排下来就是一堵墙 —— 用户找不到东西，只能问「XX 在哪」。
     * 改成「上面列功能、点进去只看那一块」，以后加功能就是往这里加一行。
     */
    var TABS = [
      ['overview', '概览'],
      ['binding', '绑定'],
      ['readers', '读者'],
      ['quarantine', '审查隔离'],
      ['stance', '对话节奏'],
      ['proactive', '主动搭话'],
      ['memory', '关系记忆'],
      ['ws', '配置'],
      ['schedule', '定时'],
      ['advanced', '高级'],
    ]

    /** 隔离区列表一次拉多少条；跟后端的默认值/上限保持一致。 */
    var QUARANTINE_DEFAULT_LIMIT = 50
    var QUARANTINE_LIMITS = [20, 50, 100, 200]
    var QUARANTINE_NOTE_MAX = 500
    // 同一页面里快速切走/切回会叠两次请求，用递增序号丢掉较旧的响应。
    var quarantineRequestSeq = 0

    var QUARANTINE_VERDICT_LABELS = {
      block: '拦截',
      suspect: '可疑',
      hold: '审查失败保留',
      allow: '允许',
    }

    var QUARANTINE_CATEGORY_LABELS = {
      none: '无',
      prompt_injection: '提示词注入',
      impersonation: '冒充身份',
      credential_exfiltration: '凭据外泄',
      permission_change: '权限变更',
      unsafe_external_action: '危险外发',
      review_error: '审查失败',
      other: '其他',
    }

    function quarantineKindLabel(kind) {
      return kind === 'group' ? '群聊' : '私聊'
    }

    function quarantineVerdictLabel(verdict) {
      return QUARANTINE_VERDICT_LABELS[String(verdict || '')] ||
        (String(verdict || '') === '' ? '未知' : String(verdict))
    }

    function quarantineVerdictClass(verdict) {
      if (verdict === 'block') return ' block'
      if (verdict === 'suspect' || verdict === 'hold') return ' suspect'
      return ''
    }

    function quarantineCategoryLabel(category) {
      return QUARANTINE_CATEGORY_LABELS[String(category || '')] ||
        (String(category || '') === '' ? '未分类' : String(category))
    }

    /** 隔离记录的时间戳是 ISO 字符串；解析不了就原样显示，别把记录变成空白。 */
    function quarantineWhen(value) {
      var raw = String(value || '')
      var ms = Date.parse(raw)
      if (!Number.isFinite(ms)) return raw === '' ? '—' : raw
      var d = new Date(ms)
      var pad = function (v) { return (v < 10 ? '0' : '') + v }
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    function QqBridgeSection(props) {
      var s1 = useState(null)
      var data = s1[0]
      var setData = s1[1]

      // 浏览器端会话列表变化时重渲染（新开会话 / 改标题都能立刻反映到下拉里）
      var sTick = useState(0)
      var setTick = sTick[1]

      var s2 = useState({ private: {}, group: {} })
      var draft = s2[0]
      var setDraft = s2[1]

      var s3 = useState({ private: '', group: '' })
      var input = s3[0]
      var setInput = s3[1]

      var s4 = useState('')
      var msg = s4[0]
      var setMsg = s4[1]

      var s5 = useState(false)
      var busy = s5[0]
      var setBusy = s5[1]

      var s6 = useState(false)
      var loading = s6[0]
      var setLoading = s6[1]

      var s7 = useState(null)
      var tunables = s7[0]
      var setTunables = s7[1]

      // 功能分区（0.9.1）：一屏只显示一块，别再把所有卡片堆成一堵墙
      var s8 = useState('overview')
      var tab = s8[0]
      var setTab = s8[1]

      // 主动搭话的选人模式：'all' 全员 / 'some' 只对勾选的人。
      // 「some 但一个都没勾」需要一个本地中间态，不能直接靠空数组表达（空数组 = 全员）。
      var s9 = useState('all')
      var targetMode = s9[0]
      var setTargetMode = s9[1]

      // Slice 3：读者表的编辑态。跟 routes 一样「先改草稿、点保存才生效」，
      // 面板里看到的勾选和模式不会立刻影响正在跑的投递。
      var s10 = useState({ private: {}, group: {} })
      var readersDraft = s10[0]
      var setReadersDraft = s10[1]

      // 0.20.x：消息准入审查隔离区（owner 侧）。只有点开「审查隔离」才拉数据，
      // 不拖慢设置页首屏；rawText 只在这个面板里渲染，不写日志。
      var s11 = useState(null)
      var quarantine = s11[0]
      var setQuarantine = s11[1]

      var s12 = useState(false)
      var quarantineLoading = s12[0]
      var setQuarantineLoading = s12[1]

      var s13 = useState('')
      var quarantineError = s13[0]
      var setQuarantineError = s13[1]

      var s14 = useState('')
      var quarantineMsg = s14[0]
      var setQuarantineMsg = s14[1]

      var s15 = useState(false)
      var quarantineBusy = s15[0]
      var setQuarantineBusy = s15[1]

      var s16 = useState(null)
      var quarantinePending = s16[0]
      var setQuarantinePending = s16[1]

      var s17 = useState('')
      var quarantineNote = s17[0]
      var setQuarantineNote = s17[1]

      var s18 = useState(QUARANTINE_DEFAULT_LIMIT)
      var quarantineLimit = s18[0]
      var setQuarantineLimit = s18[1]

      // 消息审查白名单是多行文本：直接拿数组 join 当受控值会在输入换行时把光标顶回去，
      // 所以文本单独存一份，保存时再解析成字符串数组。
      var s19 = useState('')
      var reviewWhitelistText = s19[0]
      var setReviewWhitelistText = s19[1]

      // 定时接收模式：独立 API/草稿，不跟「保存」按钮的整表 payload 混在一起。
      var s20 = useState(null)
      var scheduleData = s20[0]
      var setScheduleData = s20[1]
      var s21 = useState(null)
      var scheduleDraft = s21[0]
      var setScheduleDraft = s21[1]
      var s22 = useState('')
      var scheduleMsg = s22[0]
      var setScheduleMsg = s22[1]
      var s23 = useState(false)
      var scheduleBusy = s23[0]
      var setScheduleBusy = s23[1]

      function blankSchedule() {
        return {
          id: '', name: '', kind: 'group', target_id: '', weekdays: [1, 2, 3, 4, 5],
          time: '09:00', timezone: 'Asia/Shanghai', action_type: 'set', mode: 'backlog', fallback_mode: 'wake',
          capture_before: true, only_if_unchanged: true
        }
      }

      function loadSchedules() {
        setScheduleBusy(true)
        setScheduleMsg('')
        apiGet('/schedules')
          .then(function (result) {
            setScheduleData(result)
            setScheduleDraft(blankSchedule())
          })
          .catch(function (error) { setScheduleMsg('加载定时计划失败：' + errText(error)) })
          .then(function () { setScheduleBusy(false) })
      }

      function onScheduleField(key) {
        return function (event) {
          var value = event && event.target ? event.target.value : ''
          var checked = event && event.target ? event.target.checked : false
          setScheduleDraft(function (previous) {
            var next = Object.assign({}, previous || blankSchedule())
            next[key] = event && event.target && event.target.type === 'checkbox' ? checked : value
            // 切换 set/restore 时把另一类型的占位值重置成安全默认值。
            if (key === 'action_type') {
              next.capture_before = true
              next.only_if_unchanged = true
            }
            return next
          })
        }
      }

      function toggleScheduleWeekday(day) {
        setScheduleDraft(function (previous) {
          var next = Object.assign({}, previous || blankSchedule())
          var days = Array.isArray(next.weekdays) ? next.weekdays.slice() : []
          var index = days.indexOf(day)
          if (index >= 0) days.splice(index, 1)
          else days.push(day)
          next.weekdays = days.sort(function (a, b) { return a - b })
          return next
        })
      }

      function editSchedule(item) {
        setScheduleDraft({
          id: item.id,
          name: item.name,
          kind: item.target.kind,
          target_id: item.target.id,
          weekdays: item.weekdays.slice(),
          time: item.time,
          timezone: item.timezone || 'Asia/Shanghai',
          action_type: item.action.type,
          mode: item.action.mode || 'backlog',
          fallback_mode: item.action.fallbackMode || 'wake',
          capture_before: item.action.captureBefore !== false,
          only_if_unchanged: item.action.onlyIfUnchanged !== false
        })
        setScheduleMsg('')
      }

      function saveSchedule() {
        var draft = scheduleDraft || blankSchedule()
        if (String(draft.name || '').trim() === '') { setScheduleMsg('先填计划名称'); return }
        if (String(draft.target_id || '').trim() === '') { setScheduleMsg('先填群号或 QQ 号'); return }
        if (!Array.isArray(draft.weekdays) || draft.weekdays.length === 0) { setScheduleMsg('至少选一天'); return }
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(draft.time || ''))) { setScheduleMsg('时间要写成 HH:MM，例如 09:00'); return }
        setScheduleBusy(true)
        setScheduleMsg('')
        var body = {
          action: draft.id === '' ? 'create' : 'update',
          id: draft.id,
          name: draft.name,
          kind: draft.kind,
          target_id: draft.target_id,
          weekdays: draft.weekdays,
          time: draft.time,
          timezone: draft.timezone || 'Asia/Shanghai',
          action_type: draft.action_type,
          mode: draft.mode,
          fallback_mode: draft.fallback_mode,
          capture_before: draft.capture_before,
          only_if_unchanged: draft.only_if_unchanged,
          expectedRevision: scheduleData && typeof scheduleData.revision === 'number' ? scheduleData.revision : undefined
        }
        apiPost('/schedule-save', body)
          .then(function (result) {
            setScheduleData(result)
            setScheduleDraft(blankSchedule())
            setScheduleMsg(draft.id === '' ? '已创建定时计划。' : '已更新定时计划。')
          })
          .catch(function (error) {
            if (error && error.status === 409) {
              setScheduleMsg('保存冲突：配置已被其他窗口或定时任务修改，正在重新载入计划。')
              apiGet('/schedules').then(function (result) { setScheduleData(result) }).catch(function () {})
              return
            }
            setScheduleMsg('保存失败：' + errText(error))
          })
          .then(function () { setScheduleBusy(false) })
      }

      function scheduleAction(item, action) {
        if (action === 'delete' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('删除定时计划「' + item.name + '」？')) return
        }
        setScheduleBusy(true)
        setScheduleMsg('')
        apiPost('/schedule-save', {
          action: action,
          id: item.id,
          expectedRevision: scheduleData && typeof scheduleData.revision === 'number' ? scheduleData.revision : undefined
        })
          .then(function (result) {
            setScheduleData(result)
            setScheduleDraft(blankSchedule())
            setScheduleMsg(action === 'delete' ? '已删除。' : action === 'enable' ? '已启用。' : '已停用。')
          })
          .catch(function (error) {
            if (error && error.status === 409) {
              setScheduleMsg('配置已被其他窗口或定时任务修改，正在重新载入计划。')
              apiGet('/schedules').then(function (result) { setScheduleData(result) }).catch(function () {})
              return
            }
            setScheduleMsg('操作失败：' + errText(error))
          })
          .then(function () { setScheduleBusy(false) })
      }

      function reload(options) {
        var opts = options || {}
        setLoading(true)
        if (opts.keepMsg !== true) setMsg('')
        apiGet('/state')
          .then(function (result) {
            setData(result)
            setDraft({
              private: result.routes && result.routes.private ? result.routes.private : {},
              group: result.routes && result.routes.group ? result.routes.group : {},
            })
            setReadersDraft(cloneReaders(result.readers))
            var c = result.config || {}
            setTunables({
              groupContextCount: numOr(c.groupContextCount, 0),
              groupOnlyWhenAt: c.groupOnlyWhenAt === true,
              splitReply: c.splitReply === true,
              // 0.10.0：分条依据（paragraph = 换行分条，sentence = 按句末标点）
              splitMode: c.splitMode === 'sentence' ? 'sentence' : 'paragraph',
              splitMaxChars: numOr(c.splitMaxChars, 120),
              splitMaxParts: numOr(c.splitMaxParts, 8),
              splitMinChars: numOr(c.splitMinChars, 0),
              splitDelayMinMs: numOr(c.splitDelayMinMs, 200),
              splitDelayMaxMs: numOr(c.splitDelayMaxMs, 700),
              pollMs: numOr(c.pollMs, 2000),
              groupPollMs: numOr(c.groupPollMs, 3000),
              resumeColdSession: c.resumeColdSession !== false,
              // 0.7.1：对话节奏与沉默权
              replyQuietMs: numOr(c.replyQuietMs, 0),
              ambientCooldownMs: numOr(c.ambientCooldownMs, 60000),
              ambientMaxPending: numOr(c.ambientMaxPending, 30),
              ambientPendingMaxChars: numOr(c.ambientPendingMaxChars, 12000),
              waitMaxMs: numOr(c.waitMaxMs, 60000),
              closureEnabled: c.closureEnabled !== false,
              // 0.8.0：关系记忆与上线补历史
              memoryEnabled: c.memoryEnabled !== false,
              // 0.9.0：私聊合并窗口（标记已读的中间态）
              mergeWindowMs: numOr(c.mergeWindowMs, 0),
              mergeMaxWaitMs: numOr(c.mergeMaxWaitMs, 15000),
              mergeMaxMessages: numOr(c.mergeMaxMessages, 10),
              // 0.9.0：主动搭话
              proactiveEnabled: c.proactiveEnabled === true,
              proactiveIdleHours: numOr(c.proactiveIdleHours, 6),
              proactiveIdleMaxHours: numOr(c.proactiveIdleMaxHours, 0),
              proactiveDailyMax: numOr(c.proactiveDailyMax, 1),
              proactiveQuietFrom: String(c.proactiveQuietFrom || ''),
              proactiveQuietTo: String(c.proactiveQuietTo || ''),
              proactiveBackoffMax: numOr(c.proactiveBackoffMax, 4),
              // 0.9.1：主动搭话的对象白名单（空 = 所有已绑私聊）
              proactiveTargets: Array.isArray(c.proactiveTargets) ? c.proactiveTargets.slice() : [],
              autoForwardReply: c.autoForwardReply === true,
              backfillOnStart: c.backfillOnStart !== false,
              backfillMaxPages: numOr(c.backfillMaxPages, 5),
              backfillDeliver: numOr(c.backfillDeliver, 20),
              qzoneRequireConfirm: c.qzoneRequireConfirm !== false,
              imageCopyDir: String(c.imageCopyDir || ''),
              textPrefix: String(c.textPrefix || ''),
              wsEnabled: c.wsEnabled !== false,
              wsUrl: String(c.wsUrl || ''),
              wsFallbackPollMs: numOr(c.wsFallbackPollMs, 30000),
              // 0.15.0：HTTP API 地址（token 同样不回显，留空 = 保持原样）
              onebotHttp: String(c.onebotHttp || ''),
              // 消息准入审查：总开关/范围/并发/超时/字符上限/白名单/附件策略
              messageReviewEnabled: c.messageReviewEnabled === true,
              messageReviewScope: c.messageReviewScope === 'all' ? 'all' : 'external',
              messageReviewConcurrency: numOr(c.messageReviewConcurrency, 20),
              messageReviewTimeoutMs: numOr(c.messageReviewTimeoutMs, 5000),
              messageReviewMaxChars: numOr(c.messageReviewMaxChars, 5000),
              messageReviewWhitelist: Array.isArray(c.messageReviewWhitelist) ? c.messageReviewWhitelist.slice() : [],
              messageReviewHoldAttachments: c.messageReviewHoldAttachments !== false,
              // token 不回显：留空 = 保持原样（保存时不会误清掉）
              wsToken: '',
              token: ''
            })
            setReviewWhitelistText(Array.isArray(c.messageReviewWhitelist) ? c.messageReviewWhitelist.join('\n') : '')
            // 名单非空 = 只对选中的人；空 = 全员（跟着配置走，别自己猜）
            setTargetMode(Array.isArray(c.proactiveTargets) && c.proactiveTargets.length > 0 ? 'some' : 'all')
            if (typeof opts.message === 'string' && opts.message !== '') setMsg(opts.message)
          })
          .catch(function (error) {
            setMsg('加载失败：' + errText(error))
          })
          .then(function () {
            setLoading(false)
          })
      }

      useEffect(function () {
        reload()
      }, [])

      // 订阅浏览器端的会话列表：新开一个对话不用刷新页面就能在下拉里选到。
      // 注意：cordis 里没 inject 的服务读 ctx.xxx 会抛，必须整个包住，
      // 否则这一抛就把设置页干掉（React 的 effect 抛错会冒到边界之外）。
      useEffect(function () {
        try {
          var bridgeCtx = props !== null && props !== undefined ? props.bridgeCtx : undefined
          var sessionsSvc = bridgeCtx === null || bridgeCtx === undefined ? null : bridgeCtx.sessions
          var list = sessionsSvc === null || sessionsSvc === undefined ? null : sessionsSvc.list
          if (list === null || list === undefined || typeof list.subscribe !== 'function') return undefined
          var off = list.subscribe(function () {
            setTick(function (n) { return n + 1 })
          })
          return function () {
            if (typeof off === 'function') off()
          }
        } catch (error) {
          return undefined
        }
      }, [])

      // 定时计划按需加载；切回这一页时重新取 revision，避免拿旧草稿覆盖。
      useEffect(function () {
        if (tab !== 'schedule') return
        loadSchedules()
      }, [tab])
      // 切到「审查隔离」时自动拉一次：刚被拦下的记录不用再点刷新才看得到。
      // 数据只在 owner 打开这一页时读取，不跟着设置页首屏一起加载。
      useEffect(function () {
        if (tab !== 'quarantine') return
        loadQuarantine(quarantineLimit)
      }, [tab])


      function save() {
        // 「只对选中的人」但一个人都没勾 —— 后端用空数组表示「全员」，语义正好反过来。
        // 宁可拦住并说清楚，也别静默把配置改成她跟所有人都能搭话。
        if (targetMode === 'some' && Array.isArray(tunables && tunables.proactiveTargets) && tunables.proactiveTargets.length === 0) {
          setMsg('主动搭话选了「只对选中的人」，但一个都没勾：要么勾上人，要么切回「所有已绑私聊」。')
          return
        }
        // 白名单文本还没解析成合法数组时不要提交：后端的空数组语义是「谁都不豁免」，
        // 静默提交空数组等于把用户以为已放行的人又放回审查。
        var whitelist = parseReviewWhitelist(reviewWhitelistText)
        if (whitelist.error !== '') {
          setMsg('保存失败：白名单' + whitelist.error)
          return
        }
        setBusy(true)
        setMsg('')
        var payload = {
          routes: draft,
          // Slice 3：读者表整表提交（后端 normalizeReaders 负责清洗）
          readers: readersDraft,
          workspaceCwd: data && data.config ? data.config.workspaceCwd : undefined,
          // 乐观并发：后端拿它比对配置文件 mtime；别的窗口/工具改过就 409
          revision: data && typeof data.revision === 'number' ? data.revision : undefined,
        }
        if (tunables !== null) {
          for (var key in tunables) {
            if (!Object.prototype.hasOwnProperty.call(tunables, key)) continue
            // token 留空 = 保持原样（后端不返回 token 明文，别把已有的清了）
            if (key === 'wsToken' && String(tunables[key] || '') === '') continue
            if (key === 'token' && String(tunables[key] || '') === '') continue
            payload[key] = tunables[key]
          }
          // 名单跟当前绑定对齐：解绑了的人留在名单里就是一串永远匹配不上的 key
          var picked = Array.isArray(tunables.proactiveTargets) ? tunables.proactiveTargets : []
          payload.proactiveTargets = targetMode === 'all'
            ? []
            : boundPrivateKeys().filter(function (k) { return picked.indexOf(k) >= 0 })
          // 白名单以多行文本为草稿源；保存时解析成字符串数组（空文本 = []）。
          payload.messageReviewWhitelist = whitelist.list
        }
        apiPost('/save', payload)
          .then(function () {
            // 保存后重新拉 /state：概览、角标、积压、revision 都要用新值，
            // 否则页面显示的和「已保存」互相矛盾。
            reload({ keepMsg: true })
            setMsg('已保存，下一轮投递生效（推送链路会自己重连，不用重启）。')
          })
          .catch(function (error) {
            if (error && error.status === 409) {
              reload({ message: '保存冲突：配置已被其他窗口或工具修改，已重新载入最新配置，请确认后再保存。' })
              return
            }
            setMsg('保存失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function addRow(kind) {
        var raw = String(input[kind] || '').trim()
        if (raw === '') {
          setMsg('先填' + (kind === 'group' ? '群号' : 'QQ 号'))
          return
        }
        if (!/^\d{5,12}$/.test(raw)) {
          setMsg('号码格式不对：应该是 5~12 位数字')
          return
        }
        if (draft[kind][raw] !== undefined) {
          setMsg('这个号已经在列表里了')
          return
        }
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        next[kind][raw] = { sessionId: '', prefix: '' }
        setDraft(next)
        var nextInput = Object.assign({}, input)
        nextInput[kind] = ''
        setInput(nextInput)
        setMsg('已添加，记得选会话再保存')
      }

      function removeRow(kind, id) {
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        delete next[kind][id]
        setDraft(next)
        // 绑定没了，这个 peer 的消息就没人收，读者留着也永远收不到东西：
        // 一起从草稿里清掉，别在配置里留一串死绑定。
        if (readersOf(kind, id).length > 0) setReadersOf(kind, id, [])
        setMsg('已移除，保存后生效')
      }

      function setSession(kind, id, sessionId) {
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        next[kind][id] = Object.assign({}, next[kind][id], { sessionId: sessionId })
        setDraft(next)
      }

      /**
       * 这一路投递时正文前那行前缀（比如「（QQ 私聊）」）。
       * 以前设置页没有输入框，保存时又会被清洗掉空串 —— 配过的自定义前缀
       * 点一次「保存」就悄悄没了。现在给它一个格子，能改也能留空。
       */
      function setPrefixOf(kind, id, prefix) {
        var next = { private: Object.assign({}, draft.private), group: Object.assign({}, draft.group) }
        next[kind][id] = Object.assign({}, next[kind][id], { prefix: prefix })
        setDraft(next)
      }

      function nameOf(kind, id) {
        if (!data) return ''
        var pool = kind === 'group' ? data.groups : data.friends
        if (!Array.isArray(pool)) return ''
        for (var i = 0; i < pool.length; i++) {
          if (String(pool[i].id) === String(id)) return String(pool[i].name || '')
        }
        return ''
      }

      /**
       * 有会话的私聊 key（`private:uin`）—— 主动搭话只能对这些人开口。
       * 用 draft 而不是 data.routes：用户刚在「绑定」里加的、还没保存的也要能选。
       */
      function boundPrivateKeys() {
        var out = []
        var table = draft.private || {}
        for (var uin in table) {
          if (!Object.prototype.hasOwnProperty.call(table, uin)) continue
          var route = table[uin]
          if (String(route && route.sessionId ? route.sessionId : '') === '') continue
          out.push('private:' + uin)
        }
        return out
      }

      function pickedTargets() {
        return tunables !== null && Array.isArray(tunables.proactiveTargets) ? tunables.proactiveTargets : []
      }

      function setTargets(list) {
        if (tunables === null) return
        var next = Object.assign({}, tunables)
        next.proactiveTargets = list
        setTunables(next)
      }

      /**
       * 勾 / 取消一个人的主动资格。
       * 空数组的语义是「全员」，所以从全员状态取消一个人时要先展开成显式名单，
       * 否则「取消 A」会被后端理解成「谁都可以」—— 正好反了。
       */
      function toggleTarget(key, on) {
        var all = boundPrivateKeys()
        var cur = pickedTargets()
        if (cur.length === 0) cur = all.slice()
        var next = on === true
          ? (cur.indexOf(key) >= 0 ? cur : cur.concat([key]))
          : cur.filter(function (k) { return k !== key })
        // 顺序跟绑定表对齐，顺手丢掉已经不存在的 key
        setTargets(all.filter(function (k) { return next.indexOf(k) >= 0 }))
      }

      function switchTargetMode(mode) {
        setTargetMode(mode)
        if (mode === 'all') {
          setTargets([])
          return
        }
        // 切到「指定的人」时先把全员填进去：否则一进来就是空名单，保存会被拦，看着像坏了
        if (pickedTargets().length === 0) setTargets(boundPrivateKeys())
      }

      // ---- 读者（Slice 3）--------------------------------------------------

      /** 某个 peer 在当前草稿里的读者列表。 */
      function readersOf(kind, peerId) {
        var table = readersDraft[kind] || {}
        var list = table[String(peerId)]
        return Array.isArray(list) ? list : []
      }

      /** 整表替换的草稿更新：空列表就把这个 peer 从表里删掉，别留 `"123": []`。 */
      function setReadersOf(kind, peerId, list) {
        var next = {
          private: Object.assign({}, readersDraft.private),
          group: Object.assign({}, readersDraft.group),
        }
        if (list.length === 0) delete next[kind][String(peerId)]
        else next[kind][String(peerId)] = list
        setReadersDraft(next)
      }

      /** 新读者默认 muted：先能收、不吵人，确认手感之后再改成 wake/backlog。 */
      function addReader(kind, peerId, sessionId) {
        if (sessionId === '') return
        var list = readersOf(kind, peerId)
        if (list.some(function (reader) { return reader.sessionId === sessionId })) {
          setMsg('这个会话已经是该' + (kind === 'group' ? '群' : '好友') + '的读者了')
          return
        }
        setReadersOf(kind, peerId, list.concat([{
          sessionId: sessionId,
          wakeMode: 'muted',
          autoReply: 'off',
          read: true,
          write: false,
          backlogMaxMessages: 50,
          backlogMaxChars: 20000,
        }]))
        setMsg('已加读者（默认免打扰），保存后生效')
      }

      function removeReader(kind, peerId, sessionId) {
        setReadersOf(kind, peerId, readersOf(kind, peerId).filter(function (reader) {
          return reader.sessionId !== sessionId
        }))
        setMsg('已移除读者，保存后生效')
      }

      /** 改某个读者的投递模式（wake / backlog / muted / off）。 */
      function setReaderMode(kind, peerId, sessionId, mode) {
        setReadersOf(kind, peerId, readersOf(kind, peerId).map(function (reader) {
          if (reader.sessionId !== sessionId) return reader
          return Object.assign({}, reader, { wakeMode: mode })
        }))
      }

      /** 读者行里直接换会话：把这一条从旧会话挪到新会话。 */
      function setReaderSession(kind, peerId, fromSessionId, toSessionId) {
        if (toSessionId === '') return
        var list = readersOf(kind, peerId)
        if (list.some(function (reader) { return reader.sessionId === toSessionId })) {
          setMsg('这个会话已经是该' + (kind === 'group' ? '群' : '好友') + '的读者了')
          return
        }
        setReadersOf(kind, peerId, list.map(function (reader) {
          if (reader.sessionId !== fromSessionId) return reader
          return Object.assign({}, reader, { sessionId: toSessionId })
        }))
      }

      /** (kind, peerId, sessionId) 的积压条数；data.backlog 是 /state 算好的概要。 */
      function backlogCount(kind, peerId, sessionId) {
        var list = data && Array.isArray(data.backlog) ? data.backlog : []
        var total = 0
        for (var i = 0; i < list.length; i++) {
          var queue = list[i]
          if (queue === null || queue === undefined) continue
          if (queue.kind !== kind || String(queue.peerId) !== String(peerId)) continue
          if (sessionId !== undefined && String(queue.sessionId) !== String(sessionId)) continue
          total += Number(queue.count) || 0
        }
        return total
      }

      function sessionById(id) {
        for (var i = 0; i < sessions.length; i++) {
          if (sessions[i].id === id) return sessions[i]
        }
        return { id: id, title: '', updatedAt: '' }
      }

      /** 读者行/会话视角里显示会话名：不在当前工作区列表里也要显示得出来。 */
      function readerSessionLabel(id) {
        var known = false
        for (var i = 0; i < sessions.length; i++) {
          if (sessions[i].id === id) { known = true; break }
        }
        return sessionLabel(sessionById(id)) + (known ? '' : '（不在当前工作区）')
      }

      /** 草稿里一共有多少条读者绑定（概览和 tab 角标用）。 */
      function totalReaders() {
        var total = 0
        ;['private', 'group'].forEach(function (kind) {
          var table = readersDraft[kind] || {}
          for (var peerId in table) {
            if (Object.prototype.hasOwnProperty.call(table, peerId) !== true) continue
            total += Array.isArray(table[peerId]) ? table[peerId].length : 0
          }
        })
        return total
      }

      /** peer 视角：一行一个 peer，写者固定在「绑定」里，读者挂在这个 peer 下面。 */
      function renderPeerReaders(kind) {
        var keys = []
        var seen = {}
        Object.keys(draft[kind] || {}).forEach(function (id) {
          if (seen[id] === true) return
          seen[id] = true
          keys.push(id)
        })
        Object.keys(readersDraft[kind] || {}).forEach(function (id) {
          if (seen[id] === true) return
          seen[id] = true
          keys.push(id)
        })

        var head = h('div', { className: 'qqb-card-head', key: 'h' }, [
          h('span', { className: 'qqb-card-title', key: 't' }, kind === 'group' ? '群聊' : '私聊'),
          h('span', { className: 'qqb-note', key: 'n' }, '写者只能一个，读者可以有多个；读者只能看，不能发'),
        ])

        var body = keys.length === 0
          ? [h('div', { className: 'qqb-empty', key: 'e' },
              '还没有绑定' + (kind === 'group' ? '群' : '好友') + '。先去「绑定」里挑一个会话，再加读者。')]
          : keys.map(function (id) {
            var route = (draft[kind] || {})[id] || {}
            var writerId = String(route.sessionId || '')
            var name = nameOf(kind, id)
            var list = readersOf(kind, id)
            var taken = {}
            list.forEach(function (reader) { taken[reader.sessionId] = true })

            var readerRows = list.map(function (reader) {
              // 当前会话永远排在第一条：它可能已经不在工作区列表里了，
              // 没有这一条 select 会找不到匹配项、显示成别人的名字。
              var options = [h('option', { value: reader.sessionId, key: reader.sessionId }, readerSessionLabel(reader.sessionId))]
                .concat(sessions.filter(function (session) { return session.id !== reader.sessionId }).map(function (session) {
                  return h('option', { value: session.id, key: session.id }, sessionLabel(session))
                }))
              var count = backlogCount(kind, id, reader.sessionId)
              return h('div', { className: 'qqb-reader-row', key: 'rd-' + reader.sessionId }, [
                h('select', {
                  className: 'qqb-select',
                  key: 's',
                  value: reader.sessionId,
                  onChange: function (event) { setReaderSession(kind, id, reader.sessionId, event.target.value) },
                }, options),
                h('select', {
                  className: 'qqb-select',
                  key: 'm',
                  value: reader.wakeMode,
                  title: READER_MODES.map(function (mode) { return mode[0] + '：' + mode[2] }).join('\n'),
                  onChange: function (event) { setReaderMode(kind, id, reader.sessionId, event.target.value) },
                }, READER_MODES.map(function (mode) {
                  return h('option', { value: mode[0], key: mode[0] }, mode[1])
                })),
                h('span', { className: 'qqb-note', key: 'b', title: '还没被取走的积压条数' }, count > 0 ? count + ' 条积压' : '—'),
                h('button', {
                  className: 'qqb-btn danger',
                  key: 'x',
                  onClick: function () { removeReader(kind, id, reader.sessionId) },
                }, '移除'),
              ])
            })

            // 写者本人不能当读者：deliver 会跳过 writer，加了也是 no-op，
            // 但会在配置里留一条永远收不到副本的读者、把计数和会话视角算歪。
            if (writerId !== '') taken[writerId] = true
            var candidates = sessions.filter(function (session) { return taken[session.id] !== true })
            var adder = h('div', { className: 'qqb-reader-row', key: 'add' }, [
              h('select', {
                className: 'qqb-select',
                key: 'pick',
                value: '',
                onChange: function (event) {
                  var picked = event.target.value
                  if (picked !== '') addReader(kind, id, picked)
                  event.target.value = ''
                },
              }, [h('option', { value: '', key: '' }, candidates.length === 0 ? '— 没有别的可选会话 —' : '— 加一个读者 —')]
                .concat(candidates.map(function (session) {
                  return h('option', { value: session.id, key: session.id }, sessionLabel(session))
                }))),
              h('span', { key: 'p1' }, ''),
              h('span', { key: 'p2' }, ''),
              h('span', { key: 'p3', className: 'qqb-note' }, writerId === '' ? '写者未绑定：消息会被忽略' : '写者：' + readerSessionLabel(writerId)),
            ])

            return h('div', { className: 'qqb-reader-peer', key: kind + '-' + id }, [
              h('div', { className: 'qqb-reader-head', key: 'h' }, [
                h('span', { className: 'qqb-uin', key: 'i' }, id),
                h('span', { className: 'qqb-name', key: 'n', title: name }, name === '' ? '（未知）' : name),
                writerId === ''
                  ? h('span', { className: 'qqb-tag warn', key: 'w' }, '未绑定写者')
                  : h('span', { className: 'qqb-tag', key: 'w' }, '写：' + readerSessionLabel(writerId)),
                h('span', { className: 'qqb-tag' + (list.length === 0 ? ' warn' : ''), key: 'r' },
                  list.length === 0 ? '没有读者' : list.length + ' 个读者'),
              ]),
            ].concat(readerRows, [adder]))
          })

        return h('div', { className: 'qqb-card', key: 'peers-' + kind }, [head].concat(body))
      }

      /** 会话视角：把一个会话能读/能写的 peer 反过来列一遍。 */
      function renderSessionView() {
        var byId = {}
        var order = []
        function ensure(sessionId) {
          var id = String(sessionId || '')
          if (id === '') return null
          if (byId[id] === undefined) {
            byId[id] = { id: id, writes: [], reads: [] }
            order.push(id)
          }
          return byId[id]
        }
        ;['private', 'group'].forEach(function (kind) {
          var routes = draft[kind] || {}
          Object.keys(routes).forEach(function (peerId) {
            var item = ensure(routes[peerId] && routes[peerId].sessionId)
            if (item !== null) item.writes.push({ kind: kind, id: peerId, name: nameOf(kind, peerId) })
          })
          var table = readersDraft[kind] || {}
          Object.keys(table).forEach(function (peerId) {
            ;(Array.isArray(table[peerId]) ? table[peerId] : []).forEach(function (reader) {
              var item = ensure(reader.sessionId)
              if (item === null) return
              item.reads.push({
                kind: kind,
                id: peerId,
                name: nameOf(kind, peerId),
                wakeMode: reader.wakeMode,
                count: backlogCount(kind, peerId, reader.sessionId),
              })
            })
          })
        })

        function peerText(peer) {
          var label = (peer.kind === 'group' ? '群 ' : '私聊 ') + peer.id + (peer.name === '' ? '' : '（' + peer.name + '）')
          if (peer.wakeMode === undefined) return label
          var mode = peer.wakeMode
          READER_MODES.forEach(function (item) { if (item[0] === peer.wakeMode) mode = item[1] })
          return label + ' · ' + mode + (peer.count > 0 ? ' · ' + peer.count + ' 条积压' : '')
        }

        var head = h('div', { className: 'qqb-card-head', key: 'h' }, [
          h('span', { className: 'qqb-card-title', key: 't' }, '会话视角'),
          h('span', { className: 'qqb-note', key: 'n' }, '一个会话可以读多个 peer；写只算它自己绑定的那些'),
        ])

        var rows = order.map(function (id) {
          var item = byId[id]
          var pending = 0
          item.reads.forEach(function (read) { pending += read.count })
          return h('div', { className: 'qqb-reader-peer', key: 'sv-' + id }, [
            h('div', { className: 'qqb-reader-head', key: 'h' }, [
              h('span', { className: 'qqb-name', key: 'n', title: id }, readerSessionLabel(id)),
              h('span', { className: 'qqb-tag', key: 'w' }, '写 ' + item.writes.length),
              h('span', { className: 'qqb-tag', key: 'r' }, '读 ' + item.reads.length),
              pending > 0 ? h('span', { className: 'qqb-tag warn', key: 'b' }, '积压 ' + pending) : null,
            ]),
            h('div', { className: 'qqb-note', key: 'w' }, item.writes.length === 0
              ? '写：无（只能读）'
              : '写：' + item.writes.map(peerText).join('、')),
            h('div', { className: 'qqb-note', key: 'r' }, item.reads.length === 0
              ? '读：无'
              : '读：' + item.reads.map(peerText).join('、')),
          ])
        })

        return h('div', { className: 'qqb-card', key: 'sessions' }, [head].concat(
          rows.length === 0
            ? [h('div', { className: 'qqb-empty', key: 'e' }, '还没有会话拿到任何 peer 的权限。')]
            : rows
        ))
      }

      function renderReaders() {
        return h('div', { className: 'qqb-pane', key: 'readers' }, [
          h('div', { className: 'qqb-note', key: 'intro' },
            '一个 peer 最多一个写者（在「绑定」里选），可以有多个只读观察者。读者收到的是同一条消息的副本（正文带【只读观察】来源标签），但没有写权限：qq_send、qq_qzone_post、qq_collect_face、qq_close、qq_pass 都会拒绝它；qq_read 读积压，qq_wait 只能等它订阅的 peer。qq_msg_history/qq_remember 当前未注册。同一个会话可以同时读多个 peer。改完点右上角「保存」才生效。'),
          renderPeerReaders('private'),
          renderPeerReaders('group'),
          renderSessionView(),
        ])
      }

      // ---- 消息准入审查隔离区（owner 侧）----------------------------------

      /**
       * 拉最近 N 条隔离记录。只读接口，不改队列；rawText 随响应回来，
       * 只交给本面板渲染，不写日志、不塞进别的状态。
       */
      function loadQuarantine(limitOverride) {
        var limit = Number(limitOverride)
        if (!Number.isFinite(limit) || limit <= 0) limit = Number(quarantineLimit) || QUARANTINE_DEFAULT_LIMIT
        var requestSeq = quarantineRequestSeq + 1
        quarantineRequestSeq = requestSeq
        setQuarantineLoading(true)
        setQuarantineError('')
        setQuarantineMsg('')
        setQuarantinePending(null)
        setQuarantineNote('')
        apiGet('/review-quarantine?limit=' + encodeURIComponent(String(limit)))
          .then(function (result) {
            if (requestSeq !== quarantineRequestSeq) return
            var got = result !== null && typeof result === 'object' ? result : {}
            if (got.ok === false) throw new Error(String(got.error || '隔离区接口返回 ok=false'))
            var records = Array.isArray(got.records) ? got.records : []
            var shownLimit = Math.max(1, numOr(got.limit, limit))
            setQuarantine({
              records: records,
              total: Math.max(0, numOr(got.total, records.length)),
              skipped: Math.max(0, numOr(got.skipped, 0)),
              truncated: got.truncated === true,
              limit: shownLimit,
            })
            setQuarantineLimit(shownLimit)
          })
          .catch(function (error) {
            if (requestSeq !== quarantineRequestSeq) return
            setQuarantineError('加载隔离区失败：' + errText(error))
          })
          .then(function () {
            if (requestSeq !== quarantineRequestSeq) return
            setQuarantineLoading(false)
          })
      }

      /** 点「放行 / 忽略」先展开二次确认；备注留到确认时再提交。 */
      function askQuarantineDecision(record, action) {
        if (quarantineBusy === true || quarantineLoading === true) return
        setQuarantinePending({
          id: String(record && record.id ? record.id : ''),
          action: action === 'release' ? 'release' : 'dismiss',
        })
        setQuarantineNote('')
        setQuarantineError('')
        setQuarantineMsg('')
      }

      function cancelQuarantineDecision() {
        if (quarantineBusy === true) return
        setQuarantinePending(null)
        setQuarantineNote('')
      }

      /**
       * 真正提交处置。release / dismiss 都只把该条从隔离队列摘掉并写审计，
       * 不会把 rawText 投回会话 —— 界面文案也必须说清楚这一点。
       */
      function decideQuarantine(record, action) {
        if (quarantineBusy === true || quarantineLoading === true) return
        var id = String(record && record.id ? record.id : '')
        if (id === '') {
          setQuarantineError('这条记录缺少 id，没法处置；刷新列表后再试。')
          return
        }
        var release = action === 'release'
        var body = { id: id }
        var noteText = String(quarantineNote || '').trim()
        if (noteText !== '') body.note = noteText.slice(0, QUARANTINE_NOTE_MAX)
        setQuarantineBusy(true)
        setQuarantineError('')
        setQuarantineMsg('')
        apiPost(release ? '/review-quarantine-release' : '/review-quarantine-dismiss', body)
          .then(function (result) {
            var removed = Math.max(1, Number(result && result.removed) || 0)
            // 本地摘掉这一条，不必整页重新拉；队列里的其他记录不受影响。
            setQuarantine(function (prev) {
              if (prev === null || prev === undefined) return prev
              return {
                records: (Array.isArray(prev.records) ? prev.records : []).filter(function (row) {
                  return String(row && row.id ? row.id : '') !== id
                }),
                total: Math.max(0, (Number(prev.total) || 0) - removed),
                skipped: Number(prev.skipped) || 0,
                truncated: prev.truncated === true,
                limit: Number(prev.limit) || quarantineLimit,
              }
            })
            setQuarantinePending(null)
            setQuarantineNote('')
            setQuarantineMsg((release ? '已记录放行' : '已记录忽略') +
              '：移出 ' + String(removed) + ' 条；原文不会投回会话。')
          })
          .catch(function (error) {
            if (error && error.status === 404) {
              setQuarantinePending(null)
              setQuarantineNote('')
              setQuarantineError('这条记录已经不在了（可能已被处置或清理），刷新列表看看最新状态。')
              return
            }
            setQuarantineError((release ? '放行失败：' : '忽略失败：') + errText(error))
          })
          .then(function () {
            setQuarantineBusy(false)
          })
      }

      function changeQuarantineLimit(value) {
        var next = Number(value)
        if (!Number.isFinite(next) || next <= 0) return
        setQuarantineLimit(next)
        loadQuarantine(next)
      }

      function renderQuarantine() {
        var got = quarantine !== null && quarantine !== undefined ? quarantine : null
        var records = got !== null && Array.isArray(got.records) ? got.records : []
        var total = got !== null ? Math.max(0, Number(got.total) || 0) : 0
        var skipped = got !== null ? Math.max(0, Number(got.skipped) || 0) : 0
        var truncated = got !== null && got.truncated === true
        var shownLimit = got !== null ? Math.max(1, Number(got.limit) || quarantineLimit) : quarantineLimit
        var limitOptions = QUARANTINE_LIMITS.indexOf(shownLimit) >= 0
          ? QUARANTINE_LIMITS
          : QUARANTINE_LIMITS.concat([shownLimit])

        var notices = []
        if (truncated) notices.push('隔离文件较大，这次只读取了尾部；更早的记录没有列出来。')
        if (skipped > 0) notices.push('读取时跳过了 ' + String(skipped) + ' 行坏记录（不影响其它记录）。')
        if (total > records.length) {
          notices.push('共 ' + String(total) + ' 条待处置，列表只显示最近 ' + String(records.length) + ' 条。')
        }

        function confirmPanel(record, action) {
          var release = action === 'release'
          return h('div', { className: 'qqb-qn-confirm', key: 'confirm' }, [
            h('div', { className: 'qqb-qn-confirm-q', key: 'q' },
              release ? '确认放行这一条？' : '确认忽略这一条？'),
            h('div', { className: 'qqb-note', key: 'n' }, release
              ? '放行只记录你的决定并把该条移出隔离队列，不会把原文投回会话。'
              : '忽略会记录你的决定并把该条移出隔离队列，同样不会投递。'),
            h('input', {
              className: 'qqb-input',
              key: 'note',
              type: 'text',
              maxLength: QUARANTINE_NOTE_MAX,
              placeholder: '备注（可选，最多 500 字，写进处置审计）',
              value: quarantineNote,
              disabled: quarantineBusy === true || quarantineLoading === true,
              onChange: function (event) {
                setQuarantineNote(String(event.target.value || '').slice(0, QUARANTINE_NOTE_MAX))
              },
            }),
            h('div', { className: 'qqb-qn-confirm-actions', key: 'a' }, [
              h('button', {
                className: 'qqb-btn primary',
                key: 'ok',
                type: 'button',
                disabled: quarantineBusy === true || quarantineLoading === true,
                onClick: function () { decideQuarantine(record, action) },
              }, quarantineBusy === true ? '处理中…' : (release ? '确认放行' : '确认忽略')),
              h('button', {
                className: 'qqb-btn',
                key: 'cancel',
                type: 'button',
                disabled: quarantineBusy === true,
                onClick: cancelQuarantineDecision,
              }, '取消'),
            ]),
          ])
        }

        function recordCard(record, index) {
          var row = record !== null && record !== undefined ? record : {}
          var id = String(row.id || '')
          var rawText = String(row.rawText || '')
          var rawTruncated = row.rawTextTruncated === true
          var reason = String(row.reason || '')
          var verdict = String(row.verdict || '')
          var category = String(row.category || '')
          var kind = String(row.kind || '')
          var peerId = String(row.peerId || '')
          var messageId = String(row.messageId || '')
          var sessionId = String(row.sessionId || '')
          var pending = quarantinePending
          var isPending = id !== '' && pending !== null && pending !== undefined &&
            String(pending.id || '') === id
          var action = isPending ? String(pending.action || '') : ''
          var pendingThis = isPending && (action === 'release' || action === 'dismiss')

          return h('div', { className: 'qqb-qn-item', key: 'q-' + String(index) + '-' + id }, [
            h('div', { className: 'qqb-qn-meta', key: 'meta' }, [
              h('span', {
                className: 'qqb-qn-verdict' + quarantineVerdictClass(verdict),
                key: 'v',
                title: verdict === '' ? '' : '原始 verdict：' + verdict,
              }, quarantineVerdictLabel(verdict)),
              h('span', { className: 'qqb-tag', key: 'k' },
                quarantineKindLabel(kind) + ' ' + (peerId === '' ? '—' : peerId)),
              h('span', { className: 'qqb-hint-inline', key: 'at', title: String(row.at || '') },
                quarantineWhen(row.at)),
              h('span', { className: 'qqb-hint-inline', key: 'sess', title: sessionId },
                sessionId === '' ? '会话 —' : '会话 ' + shortSessionId(sessionId)),
              h('span', {
                className: 'qqb-tag',
                key: 'c',
                title: category === '' ? '' : '原始 category：' + category,
              }, quarantineCategoryLabel(category)),
            ]),
            h('div', { className: 'qqb-qn-sub', key: 'sub' }, [
              h('span', { className: 'qqb-uin', key: 'm' }, '消息 ' + (messageId === '' ? '—' : messageId)),
              h('span', { key: 'i', title: id === '' ? '' : '记录 id ' + id },
                '记录 ' + (id === '' ? '—' : id)),
            ]),
            h('div', { className: 'qqb-qn-reason', key: 'reason' },
              reason === '' ? '（审查没有给出理由）' : reason),
            h('details', { className: 'qqb-qn-raw', key: 'raw' }, [
              h('summary', { key: 's' },
                '查看原文（' + String(rawText.length) + ' 字' + (rawTruncated ? '，已截断' : '') + '）'),
              h('pre', { key: 'p' }, rawText === '' ? '（原文为空）' : rawText),
              rawTruncated
                ? h('div', { className: 'qqb-hint-inline', key: 't' }, '原文在服务端已截断，这里显示的是截断后的内容。')
                : null,
            ]),
            pendingThis ? null : h('div', { className: 'qqb-qn-actions', key: 'actions' }, [
              h('button', {
                className: 'qqb-btn',
                key: 'release',
                type: 'button',
                disabled: quarantineBusy === true || quarantineLoading === true,
                title: '记录放行决定并移出隔离队列；不会把原文投回会话',
                onClick: function () { askQuarantineDecision(row, 'release') },
              }, '放行'),
              h('button', {
                className: 'qqb-btn danger',
                key: 'dismiss',
                type: 'button',
                disabled: quarantineBusy === true || quarantineLoading === true,
                title: '记录忽略决定并移出隔离队列；不会投递',
                onClick: function () { askQuarantineDecision(row, 'dismiss') },
              }, '忽略'),
            ]),
            pendingThis ? confirmPanel(row, action) : null,
          ])
        }

        var toolbar = h('div', { className: 'qqb-qn-toolbar', key: 'toolbar' }, [
          h('label', { className: 'qqb-field', key: 'limit' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, '读取最近'),
            h('select', {
              className: 'qqb-select',
              key: 's',
              value: String(shownLimit),
              disabled: quarantineLoading === true || quarantineBusy === true,
              onChange: function (event) { changeQuarantineLimit(event.target.value) },
            }, limitOptions.map(function (value) {
              return h('option', { value: String(value), key: String(value) }, String(value) + ' 条')
            })),
          ]),
          h('button', {
            className: 'qqb-btn',
            key: 'reload',
            type: 'button',
            disabled: quarantineLoading === true || quarantineBusy === true,
            onClick: function () { loadQuarantine() },
          }, quarantineLoading === true ? '读取中…' : '刷新列表'),
          quarantineLoading === true && got !== null
            ? h('span', { className: 'qqb-hint-inline', key: 'loading' }, '正在刷新…')
            : null,
          h('span', { className: 'qqb-hint-inline', key: 'total' },
            got === null ? '等待读取' : '共 ' + String(total) + ' 条待处置'),
        ])

        var noticesNode = notices.length === 0 ? null : h('div', { className: 'qqb-qn-notices', key: 'notices' },
          notices.map(function (text, index) {
            return h('div', { className: 'qqb-hint-inline', key: 'notice-' + String(index) }, text)
          }))

        var errorNode = quarantineError !== '' && got !== null
          ? h('div', { className: 'qqb-err', key: 'err', style: { padding: '10px 12px' } }, quarantineError)
          : null
        var msgNode = quarantineMsg === ''
          ? null
          : h('div', { className: 'qqb-msg ok', key: 'msg', style: { padding: '8px 12px' } }, quarantineMsg)

        var body
        if (got === null) {
          body = quarantineError !== ''
            ? h('div', { key: 'error', style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' } }, [
              h('div', { className: 'qqb-err', key: 'e' }, quarantineError),
              h('button', {
                className: 'qqb-btn',
                key: 'retry',
                type: 'button',
                onClick: function () { loadQuarantine() },
              }, '重试'),
            ])
            : h('div', { className: 'qqb-empty', key: 'loading' }, '正在读取隔离区…')
        } else if (records.length === 0) {
          body = h('div', { className: 'qqb-empty', key: 'empty' },
            '隔离区是空的：现在没有被消息准入审查拦下的待处置记录。')
        } else {
          body = h('div', { className: 'qqb-qn-list', key: 'list' }, records.map(recordCard))
        }

        return h('div', { className: 'qqb-pane', key: 'quarantine' }, [
          h('div', { className: 'qqb-note', key: 'intro' },
            '这里只给 owner 看：被消息准入审查拦下的原文、结论和理由。放行/忽略都只记录决定并把该条移出隔离队列，不会把原文投回会话。原文只在这个面板里显示，不写日志；它可能包含恶意内容，只当数据看。'),
          h('div', { className: 'qqb-card', key: 'card' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '消息准入审查隔离区'),
              h('span', { className: 'qqb-hint-inline', key: 'n' },
                '审查拦截后才会写入；开关在配置文件的 messageReviewEnabled'),
            ]),
            toolbar,
            noticesNode,
            msgNode,
            errorNode,
            body,
          ]),
        ])
      }

      if (loading === true && data === null) {
        return h('div', { className: 'qqb-wrap' }, h('div', { className: 'qqb-note' }, '加载中…'))
      }

      if (data === null) {
        return h('div', { className: 'qqb-wrap' }, [
          h('div', { className: 'qqb-title', key: 't' }, 'QQ 桥接'),
          h('div', { className: 'qqb-err', key: 'e' }, msg || '加载失败'),
          h('button', { className: 'qqb-btn', key: 'b', onClick: reload }, '重试'),
        ])
      }

      var bridgeCtx = props !== null && props !== undefined ? props.bridgeCtx : undefined
      var wantCwd = String(data.config && data.config.workspaceCwd ? data.config.workspaceCwd : '')
      var sessions = mergeSessions(
        Array.isArray(data.sessions) ? data.sessions : [],
        clientSessions(bridgeCtx, wantCwd)
      )

      function renderTable(kind, title, idLabel) {
        var rows = Object.keys(draft[kind] || {})
        var head = h('div', { className: 'qqb-card-head', key: 'h' }, [
          h('span', { className: 'qqb-card-title', key: 't' }, title),
          h('span', { className: 'qqb-note', key: 'n' }, sessions.length + ' 个可选会话'),
        ])

        var body = rows.length === 0
          ? [h('div', { className: 'qqb-empty', key: 'empty' }, '还没有绑定任何' + (kind === 'group' ? '群' : '好友') + '。没绑定的号发来的消息会被忽略。')]
          : rows.map(function (id) {
            var route = draft[kind][id] || {}
            var current = String(route.sessionId || '')
            var name = nameOf(kind, id)
            return h('div', { className: 'qqb-row', key: kind + id }, [
              h('span', { className: 'qqb-uin', key: 'i' }, id),
              h('span', { className: 'qqb-name', key: 'n', title: name }, name === '' ? '（未知）' : name),
              h('select', {
                className: 'qqb-select',
                key: 's',
                value: current,
                onChange: function (event) {
                  setSession(kind, id, event.target.value)
                },
              }, [
                h('option', { value: '', key: '' }, '— 未绑定（忽略）—'),
              ].concat(
                // 已绑定但不在当前列表里（被删了 / 换了工作区）时，也给它一条 option，
                // 否则 select 找不到匹配项，只能显示第一项，还带个警告三角
                current !== '' && sessions.every(function (s) { return s.id !== current })
                  ? [h('option', { value: current, key: 'stale' }, sessionLabel({ id: current, title: '' }) + '（不在当前工作区）')]
                  : []
              ).concat(sessions.map(function (session) {
                return h('option', { value: session.id, key: session.id }, sessionLabel(session))
              }))),
              h('input', {
                className: 'qqb-input',
                key: 'p',
                type: 'text',
                title: '投递时正文前的前缀，留空 = 用全局默认',
                placeholder: '前缀（可选）',
                value: String(route.prefix || ''),
                onChange: function (event) { setPrefixOf(kind, id, event.target.value) },
              }),
              h('span', { key: 'a', style: { display: 'flex', gap: '6px' } }, [
                h('button', {
                  className: 'qqb-btn danger',
                  key: 'del',
                  onClick: function () { removeRow(kind, id) },
                }, '移除'),
              ]),
            ])
          })

        var adder = h('div', { className: 'qqb-tools', key: 'add' }, [
          h('input', {
            className: 'qqb-input',
            key: 'in',
            style: { width: '180px' },
            placeholder: idLabel,
            value: input[kind],
            onChange: function (event) {
              var next = Object.assign({}, input)
              next[kind] = event.target.value
              setInput(next)
            },
          }),
          h('button', { className: 'qqb-btn', key: 'add', onClick: function () { addRow(kind) } }, '添加'),
        ])

        return h('div', { className: 'qqb-card', key: kind }, [head].concat(body, [adder]))
      }

      /**
       * 通用字段改动处理。
       * 只有 number 类型才转数字；文本框直接存字符串
       * （以前一律 Number()，文本框填地址会变成 NaN）。
       * 放在组件层，renderAdvanced / renderWs 都要用。
       */
      function onField(key) {
        return function (event) {
          var next = Object.assign({}, tunables)
          next[key] = event.target.type === 'checkbox'
            ? event.target.checked === true
            : (event.target.type === 'number' ? Number(event.target.value) : event.target.value)
          setTunables(next)
        }
      }

      /** 多行白名单输入只改文本草稿；保存时再解析成数组。 */
      function onReviewWhitelistChange(event) {
        setReviewWhitelistText(String(event.target.value || ''))
      }

      function renderSchedules() {
        var list = scheduleData && Array.isArray(scheduleData.schedules) ? scheduleData.schedules : []
        var draft = scheduleDraft || blankSchedule()
        var weekdayNames = ['一', '二', '三', '四', '五', '六', '日']
        var rowStyle = { display: 'grid', gridTemplateColumns: 'minmax(150px, 1.4fr) minmax(120px, 1fr) minmax(110px, 1fr) auto', gap: '8px', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1,#eef0f3)' }
        return h('div', { className: 'qqb-pane', key: 'schedule' }, [
          h('div', { className: 'qqb-card', key: 'list' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '定时接收模式'),
              h('span', { className: 'qqb-hint-inline', key: 'n' }, list.length + ' 条计划 · 每行显示时区'),
            ]),
            list.length === 0
              ? h('div', { className: 'qqb-empty', key: 'empty' }, '还没有定时计划。下面新建一条，例如工作日 09:00 切 backlog、12:00 恢复。')
              : list.map(function (item) {
                  var actionText = item.action.type === 'set'
                    ? '设置 ' + String(item.action.mode || '')
                    : '恢复 ' + String(item.action.fallbackMode || 'wake')
                  return h('div', { key: item.id, style: rowStyle }, [
                    h('div', { key: 'n' }, [
                      h('div', { key: 'name', style: { fontWeight: '600' } }, item.name),
                      h('div', { className: 'qqb-note', key: 'meta' }, item.target.kind + ':' + item.target.id + ' · ' + item.weekdays.map(function (d) { return '周' + weekdayNames[d - 1] }).join(',') + ' ' + item.time + ' ' + (item.timezone || 'Asia/Shanghai')),
                    ]),
                    h('div', { key: 'a', className: 'qqb-note' }, actionText),
                    h('div', { key: 'e', className: 'qqb-note' }, item.enabled ? '启用' : '停用'),
                    h('div', { key: 'b', style: { display: 'flex', gap: '6px' } }, [
                      h('button', { className: 'qqb-btn', key: 'edit', disabled: scheduleBusy, onClick: function () { editSchedule(item) } }, '编辑'),
                      h('button', { className: 'qqb-btn', key: 'toggle', disabled: scheduleBusy, onClick: function () { scheduleAction(item, item.enabled ? 'disable' : 'enable') } }, item.enabled ? '停用' : '启用'),
                      h('button', { className: 'qqb-btn danger', key: 'del', disabled: scheduleBusy, onClick: function () { scheduleAction(item, 'delete') } }, '删除'),
                    ]),
                  ])
                }),
          ]),
          h('div', { className: 'qqb-card', key: 'form' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, draft.id === '' ? '新建计划' : '编辑计划'),
              h('button', { className: 'qqb-btn', key: 'new', disabled: scheduleBusy, onClick: function () { setScheduleDraft(blankSchedule()); setScheduleMsg('') } }, '空白新建'),
            ]),
            h('div', { className: 'qqb-adv', key: 'b' }, [
              h('label', { className: 'qqb-field', key: 'name' }, [
                h('span', { className: 'qqb-field-label', key: 'l' }, '名称'),
                h('input', { className: 'qqb-input', key: 'i', value: draft.name, placeholder: '工作日午休', onChange: onScheduleField('name') }),
              ]),
              h('label', { className: 'qqb-field', key: 'kind' }, [
                h('span', { className: 'qqb-field-label', key: 'l' }, '目标类型'),
                h('select', { className: 'qqb-input', key: 'i', value: draft.kind, onChange: onScheduleField('kind') }, [
                  h('option', { value: 'group', key: 'g' }, '群聊'),
                  h('option', { value: 'private', key: 'p' }, '私聊'),
                ]),
              ]),
              h('label', { className: 'qqb-field', key: 'target' }, [
                h('span', { className: 'qqb-field-label', key: 'l' }, '目标号码'),
                h('input', { className: 'qqb-input', key: 'i', value: draft.target_id, placeholder: '群号或 QQ 号', onChange: onScheduleField('target_id') }),
              ]),
              h('label', { className: 'qqb-field wide', key: 'days' }, [
                h('span', { className: 'qqb-field-label', key: 'l' }, '周几'),
                h('div', { key: 'box', style: { display: 'flex', gap: '10px', flexWrap: 'wrap', paddingTop: '4px' } }, weekdayNames.map(function (label, index) {
                  var day = index + 1
                  return h('label', { key: day, style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } }, [
                    h('input', { type: 'checkbox', key: 'c', checked: draft.weekdays.indexOf(day) >= 0, onChange: function () { toggleScheduleWeekday(day) } }),
                    h('span', { key: 'l' }, '周' + label),
                  ])
                })),
              ]),
              h('label', { className: 'qqb-field', key: 'time' }, [
                h('span', { className: 'qqb-field-label', key: 'l' }, '时间'),
                h('input', { className: 'qqb-input', key: 'i', type: 'time', value: draft.time, onChange: onScheduleField('time') }),
              ]),
              h('label', { className: 'qqb-field', key: 'timezone' }, [
                h('span', { className: 'qqb-field-label', key: 'l' }, '时区'),
                h('input', { className: 'qqb-input', key: 'i', value: draft.timezone || 'Asia/Shanghai', placeholder: 'Asia/Shanghai', onChange: onScheduleField('timezone') }),
              ]),
              h('label', { className: 'qqb-field', key: 'atype' }, [
                h('span', { className: 'qqb-field-label', key: 'l' }, '动作'),
                h('select', { className: 'qqb-input', key: 'i', value: draft.action_type, onChange: onScheduleField('action_type') }, [
                  h('option', { value: 'set', key: 's' }, '设置模式'),
                  h('option', { value: 'restore', key: 'r' }, '恢复上次'),
                ]),
              ]),
              draft.action_type === 'set'
                ? h('label', { className: 'qqb-field', key: 'mode' }, [
                    h('span', { className: 'qqb-field-label', key: 'l' }, '模式'),
                    h('select', { className: 'qqb-input', key: 'i', value: draft.mode, onChange: onScheduleField('mode') }, [
                      h('option', { value: 'wake', key: 'w' }, 'wake'),
                      h('option', { value: 'ambient', key: 'a' }, 'ambient'),
                      h('option', { value: 'backlog', key: 'b' }, 'backlog'),
                      h('option', { value: 'muted', key: 'm' }, 'muted'),
                    ]),
                  ])
                : h('label', { className: 'qqb-field', key: 'fallback' }, [
                    h('span', { className: 'qqb-field-label', key: 'l' }, '快照为空恢复'),
                    h('select', { className: 'qqb-input', key: 'i', value: draft.fallback_mode, onChange: onScheduleField('fallback_mode') }, [
                      h('option', { value: 'wake', key: 'w' }, 'wake'),
                      h('option', { value: 'ambient', key: 'a' }, 'ambient'),
                      h('option', { value: 'backlog', key: 'b' }, 'backlog'),
                      h('option', { value: 'muted', key: 'm' }, 'muted'),
                    ]),
                  ]),
              draft.action_type === 'set'
                ? h('label', { className: 'qqb-check', key: 'capture' }, [
                    h('input', { type: 'checkbox', key: 'c', checked: draft.capture_before !== false, onChange: onScheduleField('capture_before') }),
                    h('span', { key: 'l' }, '记录变更前状态（restore 用）'),
                  ])
                : h('label', { className: 'qqb-check', key: 'unchanged' }, [
                    h('input', { type: 'checkbox', key: 'c', checked: draft.only_if_unchanged !== false, onChange: onScheduleField('only_if_unchanged') }),
                    h('span', { key: 'l' }, '用户手动改过模式时不覆盖'),
                  ]),
              h('div', { className: 'qqb-wide', key: 'actions', style: { paddingTop: '6px' } }, [
                h('button', { className: 'qqb-btn primary', key: 'save', disabled: scheduleBusy, onClick: saveSchedule }, scheduleBusy ? '处理中…' : '保存计划'),
                scheduleMsg === '' ? null : h('span', { key: 'msg', className: scheduleMsg.indexOf('失败') >= 0 ? 'qqb-err' : 'qqb-hint-inline', style: { marginLeft: '10px' } }, scheduleMsg),
              ]),
            ]),
          ]),
        ])
      }

      function renderAdvanced() {
        var t = tunables
        if (t === null) return null
        var whitelist = parseReviewWhitelist(reviewWhitelistText)

        function numberField(key, label, unit, hint, min, max) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input qqb-num',
              key: 'i',
              type: 'number',
              min: min === undefined ? 0 : min,
              max: max,
              value: t[key],
              onChange: onField(key),
            }),
            h('span', { className: 'qqb-unit', key: 'u' }, unit || ''),
          ])
        }

        function selectField(key, label, options, hint) {
          var current = String(t[key] || '')
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('select', {
              className: 'qqb-input',
              key: 'i',
              value: current,
              onChange: onField(key),
            }, options.map(function (item) {
              return h('option', { value: item.value, key: item.value }, item.label)
            })),
          ])
        }

        function boolField(key, label, hint) {
          return h('label', { className: 'qqb-check', key: key, title: hint || '' }, [
            h('input', { type: 'checkbox', key: 'c', checked: t[key] === true, onChange: onField(key) }),
            h('span', { key: 'l' }, label),
          ])
        }

        function textField(key, label, placeholder, hint) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input',
              key: 'i',
              type: 'text',
              placeholder: placeholder || '',
              value: t[key] || '',
              onChange: onField(key),
            }),
          ])
        }

        var advancedCard = h('div', { className: 'qqb-card', key: 'advanced' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '高级设置'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '改完点上面的「保存」'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            numberField('groupContextCount', '群聊上下文', '条', '被 @ 时附带前面几条群消息当上下文，0 = 不带'),
            numberField('splitMaxChars', '每段最多', '字', '分条发送时单条最多多少字'),
            numberField('splitMaxParts', '最多几条', '条', '一次回复最多拆几条，超出的合并'),
            numberField('splitMinChars', '碎片阈值', '字', '小于这个字数的碎片并进相邻一条，避免「嗯。」单独成条'),
            numberField('splitDelayMinMs', '间隔最小', 'ms', '分条之间最少等多久'),
            numberField('splitDelayMaxMs', '间隔最大', 'ms', '分条之间最多等多久'),
            numberField('pollMs', '私聊轮询', 'ms', '多久拉一次私聊消息（WS 正常时降为下面的补漏间隔）'),
            numberField('groupPollMs', '群聊轮询', 'ms', '多久拉一次群消息'),
            numberField('wsFallbackPollMs', '推送时补漏', 'ms', 'WS 正常时的低频轮询，防漏事件；WS 断开自动回到「私聊轮询」'),
            textField('textPrefix', '默认正文前缀', '（QQ 私聊）', '私聊投递时正文前那行字；单条路由想换前缀就在上面的表格里填'),
            textField('imageCopyDir', '图片副本目录', '留空 = 工作区\\收到的图片', '收到图片时另存一份人能看的副本；填 off 就不存'),
            boolField('groupOnlyWhenAt', '群里只在 @ 时响应', '关掉后群里每条消息都投递'),
            boolField('splitReply', '按标点自动分条', '长回复按标点切成多条再发。模型自己给了 segments 时以它为准，不看这个'),
            boolField('resumeColdSession', '会话没打开时自动冷启动', '关掉后只有开着的会话才收消息'),
            boolField('qzoneRequireConfirm', '发说说必须带 confirm', '对外发布且撤不回，默认开；关掉等于允许她随手发'),
          ]),
        ])

        var reviewCard = h('div', { className: 'qqb-card', key: 'review' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '消息准入审查'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '开启后逐条审查外部消息；默认关闭'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            boolField('messageReviewEnabled', '启用消息准入审查',
              '开启后，非白名单的外部消息逐条调用模型审查；命中占位符、原文进隔离队列。'),
            t.messageReviewEnabled === true
              ? h('div', { className: 'qqb-hint-inline qqb-wide', key: 'review-warn' },
                  '已开启：每条外部消息都会产生模型调用，失败会 hold。确认并发/超时/白名单后再开会话。')
              : null,
            selectField('messageReviewScope', '审查范围', [
              { value: 'external', label: '只看外部（owner 豁免）' },
              { value: 'all', label: '全部消息（含 owner）' },
            ], 'external = 用户本人消息跳过审查；all = owner 也审。'),
            numberField('messageReviewConcurrency', '审查并发', '条', '同时最多几个审查请求；默认 20', 1, 64),
            numberField('messageReviewTimeoutMs', '单条超时', 'ms', '超时即 hold；默认 5000', 500, 60000),
            numberField('messageReviewMaxChars', '单条字符上限', '字', '超过直接 hold；默认 5000，覆盖 QQ 单条约 4500 字', 100, 50000),
            h('label', { className: 'qqb-field wide', key: 'whitelist', title: '命中白名单的消息跳过模型审查' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, '白名单'),
              h('textarea', {
                className: 'qqb-input qqb-textarea',
                key: 'i',
                rows: 3,
                placeholder: 'user:1000000001\ngroup:123456789',
                value: reviewWhitelistText,
                onChange: onReviewWhitelistChange,
              }),
            ]),
            whitelist.error === ''
              ? h('div', { className: 'qqb-hint-inline qqb-wide', key: 'whitelist-hint' },
                  whitelist.list.length === 0
                    ? '一行一条（也可以逗号分隔）：user:<QQ号> 或 group:<群号>，只含数字。留空 = 不豁免任何人。'
                    : '共 ' + String(whitelist.list.length) + ' 条；这些用户 / 群的消息跳过模型审查（user:<QQ号> 或 group:<群号>）。一行一条或用逗号分隔。')
              : h('div', { className: 'qqb-err qqb-wide', key: 'whitelist-err' },
                  '白名单' + whitelist.error),
            boolField('messageReviewHoldAttachments', '模型不支持图片时 hold 附件',
              '模型声明支持图片时，图片会随文本一起交给 reviewer；模型不支持或取不到图片能力时才直接 hold（原文进隔离队列）'),
            h('div', { className: 'qqb-hint-inline qqb-wide', key: 'review-note' },
              '白名单/附件策略与总开关保存后下一轮投递生效；开启审查会按每条外部消息产生模型调用。'),
          ]),
        ])

        return h('div', { className: 'qqb-pane', key: 'advanced' }, [advancedCard, reviewCard])
      }

      /**
       * 对话节奏 —— 0.7.1 的「沉默权」旋钮。
       * 这些以前只在配置文件里，用户想调手感得手改 JSON。放进界面才算真能用。
       */
      function renderStance() {
        var t = tunables
        if (t === null) return null

        function numberField(key, label, unit, hint, placeholder) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input qqb-num',
              key: 'i',
              type: 'number',
              min: 0,
              placeholder: placeholder || '',
              value: t[key],
              onChange: onField(key),
            }),
            h('span', { className: 'qqb-unit', key: 'u' }, unit || ''),
          ])
        }

        function boolField(key, label, hint) {
          return h('label', { className: 'qqb-check', key: key, title: hint || '' }, [
            h('input', { type: 'checkbox', key: 'c', checked: t[key] === true, onChange: onField(key) }),
            h('span', { key: 'l' }, label),
          ])
        }

        /** 下拉选择：分条依据这种「只能从几个值里挑一个」的字段。 */
        function selectField(key, label, options, hint) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('select', {
              className: 'qqb-select',
              key: 'i',
              value: t[key],
              onChange: onField(key),
            }, options.map(function (item) {
              return h('option', { value: item[0], key: item[0] }, item[1])
            })),
          ])
        }

        return h('div', { className: 'qqb-card', key: 'stance' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '对话节奏'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '她什么时候开口、愿意等多久'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            selectField('splitMode', '怎么分条', [
              ['paragraph', '按换行分（她自己决定说几条）'],
              ['sentence', '按句末标点切（老行为，一句一条）'],
            ], '按换行：她写几行就发几条，句号不算分条；按标点：每个。！？都拆一条，像真人一句句打出来。改完下一轮生效'),
            numberField('ambientCooldownMs', '非@唤醒冷却', 'ms', 'ambient 模式下，非 @ 群消息唤醒后的冷却时间；冷却中的消息会滞留到 CD 结束一起投递。私聊 ambient 等同 wake。'),
            numberField('ambientMaxPending', '非@滞留上限', '条', '冷却期间最多保留多少条非 @ 消息；超出丢最老的。'),
            numberField('ambientPendingMaxChars', '非@滞留字符上限', '字', '冷却期间最多保留多少字符；超出丢最老的。'),
            numberField('replyQuietMs', '回复前静默', 'ms', '收到消息后先等够这么久再交给模型，让她看起来在「看手机」而不是秒回。0 = 关。建议试 5000，总预算 60 秒封顶（防刷屏）'),
            numberField('mergeWindowMs', '合并窗口', 'ms', '私聊连发几条时先攒一会儿再一起回（「标记已读」的中间态：先记账，不立刻开回合）。0 = 关，回到来一条回一条。跟「回复前静默」会叠加，两个都开时延迟相加'),
            numberField('mergeMaxWaitMs', '合并上限', 'ms', '最多攒这么久就强制放行 —— 对方一直发也不能无限等'),
            numberField('mergeMaxMessages', '合并条数', '条', '池里攒到这么多条立刻放行，一口气十条已经不算「还没说完」'),
            numberField('waitMaxMs', '等待上限', 'ms', 'qq_wait 一次最多等多久'),
            boolField('closureEnabled', '允许判断收尾', '开着才会在双方都收尾时用 qq_close 结束会话；对方还有问题没答时会硬判继续。卡在收尾上时临时关掉'),
            boolField('autoForwardReply', '自动转发回复', '默认关：只有 qq_send 才会发到 QQ；打开后回合结束的正文也会自动发回'),
            boolField('backfillOnStart', '上线补历史', '掉线期间攒的消息按游标翻回来（每页 50 条），否则超过 10 条会永久丢'),
            numberField('backfillMaxPages', '补历史最多', '页', '每个对象最多往回翻几页'),
            numberField('backfillDeliver', '补历史投递', '条', '超出的只报数不展开，避免灌爆上下文'),
          ]),
        ])
      }

      /** 主动搭话为什么没说 —— 把后端的 reason 翻成人话（排障时不用去翻源码）。 */
      function reasonText(reason) {
        var map = {
          off: '开关关着',
          'quiet-hours': '静默时段',
          'never-talked': '还没来往过',
          'daily-quota': '今天的次数用完了',
          'not-idle-enough': '还没到空闲时长',
          backoff: '上次主动没被回，正在退避',
          force: '手动触发',
          ok: '现在可以开口',
          'deliver-failed': '没找到可用会话',
          'not-bound': '没绑会话或不在主动名单里',
        }
        return map[String(reason || '')] || String(reason || '')
      }

      function fmtWhen(ms) {
        var n = Number(ms) || 0
        if (n <= 0) return '—'
        var d = new Date(n)
        var pad = function (v) { return (v < 10 ? '0' : '') + v }
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      }

      /**
       * 主动搭话（0.9.0）—— 没人叫她时，她自己想起来找你。
       * 这一层最容易做错：写成「定时问候」就毁了她。所以四道闸全部可见、可调。
       *
       * 0.9.1 起分两张卡：上面是「怎么开口」（节奏与闸），下面是「对谁开口」（名单）。
       * 选人单独一张卡 —— 混在一堆数字里没人看得见，而「只对谁开口」恰恰是最该先定的事。
       */
      function renderProactive() {
        var t = tunables
        if (t === null) return null
        var pro = data && data.proactive ? data.proactive : null
        var peers = pro !== null && Array.isArray(pro.peers) ? pro.peers : []

        // 状态按 key 索引：名单里每个人都能查到「上次什么时候开的口 / 今天几次 / 为什么还不出声」
        var stateOf = {}
        for (var i = 0; i < peers.length; i++) {
          var item = peers[i]
          if (item !== null && item !== undefined && item.key !== undefined) stateOf[String(item.key)] = item
        }

        var bound = boundPrivateKeys()
        var picked = pickedTargets()
        var allMode = targetMode !== 'some'

        function numberField(key, label, unit, hint) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input qqb-num',
              key: 'i',
              type: 'number',
              min: 0,
              step: key === 'proactiveIdleHours' || key === 'proactiveIdleMaxHours' ? 0.5 : 1,
              value: t[key],
              onChange: onField(key),
            }),
            h('span', { className: 'qqb-unit', key: 'u' }, unit || ''),
          ])
        }

        function textField(key, label, placeholder, hint) {
          return h('label', { className: 'qqb-field', key: key, title: hint || '' }, [
            h('span', { className: 'qqb-field-label', key: 'l' }, label),
            h('input', {
              className: 'qqb-input',
              key: 'i',
              type: 'text',
              placeholder: placeholder || '',
              value: t[key] || '',
              onChange: onField(key),
            }),
          ])
        }

        function modeRadio(mode, label, hint) {
          return h('label', { className: 'qqb-check', key: 'm-' + mode, title: hint }, [
            h('input', {
              type: 'radio',
              key: 'r',
              name: 'qqb-proactive-mode',
              checked: (mode === 'all') === allMode,
              onChange: function () { switchTargetMode(mode) },
            }),
            h('span', { key: 'l' }, label),
          ])
        }

        var targetRows
        if (bound.length === 0) {
          targetRows = [h('div', { className: 'qqb-empty', key: 'empty' }, '还没有绑好会话的私聊。先到「绑定」里给某个人选一个会话，再回来决定对谁开口。')]
        } else {
          targetRows = bound.map(function (key) {
            var uin = key.slice('private:'.length)
            var st = stateOf[key] || null
            var name = nameOf('private', uin)
            var on = allMode ? true : picked.indexOf(key) >= 0
            var status = st === null
              ? '还没来往过（从没收到过他的消息）'
              : '上次主动 ' + fmtWhen(st.lastProactiveAt) + ' · 收到消息 ' + fmtWhen(st.lastIncomingAt) +
                ' · 今天 ' + String(st.countToday) + ' 次 · ' + reasonText(st.reason)
            return h('div', { className: 'qqb-tgt-row', key: key }, [
              h('input', {
                type: 'checkbox',
                key: 'c',
                checked: on,
                title: allMode ? '现在是「所有已绑私聊」，取消勾选会自动切到「只对选中的人」' : '',
                onChange: function (event) {
                  // 全员模式下取消一个人 = 把名单展开成「除他以外的所有人」
                  if (allMode) setTargetMode('some')
                  toggleTarget(key, event.target.checked === true)
                },
              }),
              h('span', { className: 'qqb-uin', key: 'u' }, uin),
              h('div', { className: 'qqb-tgt-main', key: 'm' }, [
                h('span', { className: 'qqb-name', key: 'n', title: name }, name === '' ? '（未知）' : name),
                h('span', { className: 'qqb-hint-inline', key: 's' }, status),
              ]),
              h('button', {
                className: 'qqb-btn',
                key: 'try',
                disabled: busy,
                title: '对这个人立刻试一次（跳过开关和所有闸，说不说仍由她定）',
                onClick: function () { runProactiveNow(key) },
              }, '对TA试一次'),
            ])
          })
        }

        return h('div', { className: 'qqb-pane', key: 'proactive' }, [
          h('div', { className: 'qqb-card', key: 'knobs' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '主动搭话'),
              h('span', { className: 'qqb-hint-inline', key: 'n' }, '没人叫她时，她自己想起来找你'),
            ]),
            h('div', { className: 'qqb-adv', key: 'b' }, [
              h('label', { className: 'qqb-check', key: 'en', title: '打开后每 60 秒看一次该不该开口；关着时完全不发任何消息' }, [
                h('input', { type: 'checkbox', key: 'c', checked: t.proactiveEnabled === true, onChange: onField('proactiveEnabled') }),
                h('span', { key: 'l' }, '允许她主动开口（只对已绑会话的私聊生效，不在群里搭话）'),
              ]),
              numberField('proactiveIdleHours', '空闲多久', '小时', '距上次说话至少这么久才考虑开口。可填小数，比如 2.5'),
              numberField('proactiveIdleMaxHours', '空闲上限', '小时', '填得比上面大，门槛就变成「下限~上限」之间随机（每段安静期摇一次号）。0 = 固定用下限'),
              numberField('proactiveDailyMax', '每天最多', '次', '每日主动上限，0 = 一次都不主动'),
              numberField('proactiveBackoffMax', '退避上限', '倍', '上次主动对方没回，下次要求的时间翻倍；最多放大到这么多倍（防止每天定时问候）'),
              textField('proactiveQuietFrom', '静默开始', '23:00', '这段时间一次都不主动，写 HH:MM（本地时间）'),
              textField('proactiveQuietTo', '静默结束', '08:00', '跨午夜就写成 23:00 → 08:00'),
            ]),
          ]),
          h('div', { className: 'qqb-card', key: 'whom' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '对谁开口'),
              h('span', { className: 'qqb-hint-inline', key: 'n' }, allMode ? '所有已绑私聊' : '只对勾选的人（' + String(picked.length) + ' / ' + String(bound.length) + '）'),
            ]),
            h('div', { className: 'qqb-mode', key: 'mode' }, [
              modeRadio('all', '所有已绑私聊', '谁都可以 —— 以后新绑的人自动进名单'),
              modeRadio('some', '只对勾选的人', '只对下面勾上的人开口；勾掉的人连「该不该说」都不会算'),
            ]),
            h('div', { key: 'rows', style: { padding: '4px 0 0' } }, targetRows),
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', {
                className: 'qqb-btn',
                key: 'try',
                disabled: busy,
                onClick: function () { runProactiveNow('') },
              }, '现在试一次'),
              h('span', { className: 'qqb-note', key: 'n' }, nextText(pro)),
            ]),
          ]),
        ])
      }

      /**
       * 「现在试一次」打给谁 —— 必须写出来。
       * 之前这里是「只打名单第一个人」，连点三次全发给同一个人，
       * 另一个号永远轮不到，看着就像「另一个对话没收到」。
       */
      function nextText(pro) {
        var next = pro !== null && pro !== undefined && pro.next ? pro.next : null
        if (next === null) {
          return '现在没有可主动的对象：回到「绑定」给某个人选好会话，再来试。'
        }
        var uin = String(next.uin || '')
        var name = nameOf('private', uin)
        var who = (name === '' ? '' : name + ' ') + '（' + uin + '）'
        return '下一个轮到 ' + who + ' —— 谁最久没被找过就轮到谁，连点会自动换人。'
          + '只想试某一个人，就点他那行的「对TA试一次」。'
      }

      function runProactiveNow(onlyKey) {
        setBusy(true)
        setMsg('')
        apiPost('/proactive-now', onlyKey ? { only: onlyKey } : {})
          .then(function (result) {
            var sent = Number(result && result.sent ? result.sent : 0)
            if (sent > 0) {
              setMsg('已经投出去了 —— 去 QQ 看看她说了什么（可能在几秒后，取决于分条间隔）。')
            } else {
              var skipped = result && Array.isArray(result.skipped) ? result.skipped : []
              var why = skipped.length > 0 ? reasonText(skipped[0].reason) : '没有可主动的对象'
              setMsg('这轮没开口：' + why + '（要先在私聊表格里给某个号绑好会话）')
            }
            // 只更新主动搭话那一块，不整页 reload：否则用户还没保存的草稿会被冲掉
            if (result && result.proactive) {
              setData(function (prev) { return Object.assign({}, prev, { proactive: result.proactive }) })
            }
          })
          .catch(function (error) {
            setMsg('触发失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      /** 记忆卡面板：能看见她记住了谁，也能一键清空。 */
      function renderMemory() {
        var t = tunables
        if (t === null) return null
        var mem = data && data.memory ? data.memory : null
        var peers = mem !== null && Array.isArray(mem.peers) ? mem.peers : []
        var count = mem !== null ? Number(mem.count || 0) : 0

        var rows = peers.length === 0
          ? [h('div', { className: 'qqb-empty', key: 'empty' }, '还没记住任何人。等有消息投递过，或者她说「记住你叫什么」之后才会出现。')]
          : peers.slice(0, 6).map(function (item) {
            return h('div', { className: 'qqb-mem-row', key: String(item.key) }, [
              h('span', { className: 'qqb-mem-key', key: 'k' }, String(item.key)),
              h('span', { className: 'qqb-name', key: 'n' }, item.nick === '' ? '（还没起称呼）' : String(item.nick)),
              h('span', { className: 'qqb-hint-inline', key: 'f' }, '记得 ' + String(item.facts) + ' 条 · 说过 ' + String(item.count) + ' 句'),
            ])
          })

        return h('div', { className: 'qqb-card', key: 'memory' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '关系记忆'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, count === 0 ? '空' : '记住了 ' + count + ' 个对象'),
          ]),
          h('div', { className: 'qqb-mem', key: 'b' }, [
            h('label', { className: 'qqb-check', key: 'en', title: '关掉后不再注入「关于他：…」，也不自动记昵称' }, [
              h('input', { type: 'checkbox', key: 'c', checked: t.memoryEnabled === true, onChange: onField('memoryEnabled') }),
              h('span', { key: 'l' }, '把「关于他 / 这个群」带进正文（关掉后回复里不再多出一段记忆）'),
            ]),
          ].concat(rows, [
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', {
                className: 'qqb-btn danger',
                key: 'clear',
                disabled: busy || count === 0,
                onClick: clearMemoryCards,
              }, '清空全部记忆'),
              h('span', { className: 'qqb-note', key: 'n' }, '记忆落在 ~/.dsh/qq-bridge-memory.json，重启不丢；清空不可撤销'),
            ]),
          ])),
        ])
      }

      function clearMemoryCards() {
        var ok = window.confirm('清空她记住的所有人（称呼、喜好、说话次数）？\n\n这个操作不能撤销。')
        if (ok !== true) return
        setBusy(true)
        setMsg('')
        apiPost('/memory-clear', {})
          .then(function (result) {
            setMsg('记忆已清空（' + String((result && result.memory && result.memory.count) || 0) + ' 个对象）')
            if (result && result.memory) {
              setData(function (prev) { return Object.assign({}, prev, { memory: result.memory }) })
            }
          })
          .catch(function (error) {
            setMsg('清空失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function detectWs() {        setBusy(true)
        setMsg('')
        apiPost('/detect-ws', {})
          .then(function (result) {
            setMsg('已找到 WS 接入点：' + String(result.url || '') + '（来源 ' + String(result.source || '') + '），记得点「保存」')
            // 只改表单字段，不整页 reload（保留其它未保存的修改）
            if (tunables !== null) {
              setTunables(Object.assign({}, tunables, { wsUrl: String(result.url || '') }))
            }
          })
          .catch(function (error) {
            setMsg('自动发现失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      /** 自动发现 HTTP API 接入点（0.15.0）。与 WS 那套 token 不同，别混。 */
      function detectHttp() {
        setBusy(true)
        setMsg('')
        apiPost('/detect-http', {})
          .then(function (result) {
            setMsg('已找到 HTTP 接入点：' + String(result.url || '') +
              (result.hasToken === true ? '（含 token）' : '（该部署未给 HTTP 设 token）') +
              '，来源 ' + String(result.source || '') + '，记得点「保存」')
            if (tunables !== null) {
              setTunables(Object.assign({}, tunables, { onebotHttp: String(result.url || '') }))
            }
          })
          .catch(function (error) {
            setMsg('自动发现失败：' + errText(error))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function renderWs() {
        var t = tunables
        if (t === null) return null
        return h('div', { className: 'qqb-card', key: 'ws' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, 'HTTP API'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '轮询与发送都走这条；WS 断开时靠它兜底'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            h('label', { className: 'qqb-field', key: 'url' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'HTTP 地址（留空 = 保持原样）'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'text',
                title: '留空 = 保持原样（不回显 token，所以清空输入框不会清掉已保存的地址）',
                placeholder: 'http://127.0.0.1:3000/',
                value: t.onebotHttp || '',
                onChange: onField('onebotHttp')
              }),
            ]),
            h('label', { className: 'qqb-field', key: 'tk' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'HTTP token'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'password',
                placeholder: '留空 = 保持原样',
                value: t.token || '',
                onChange: onField('token')
              }),
            ]),
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', { className: 'qqb-btn', key: 'd', onClick: detectHttp, disabled: busy }, '自动发现（读 SnowLuma 配置）'),
              h('span', { className: 'qqb-note', key: 'n' }, 'HTTP 的端口/token 在 config/onebot_*.json 的 httpServers 里，跟 WS 那套不是同一个 token，混用会 401'),
            ]),
          ]),
        ])
      }

      function renderPush() {
        var t = tunables
        if (t === null) return null
        return h('div', { className: 'qqb-card', key: 'push' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, 'WebSocket 推送'),
            h('span', { className: 'qqb-hint-inline', key: 'n' }, '实时收消息；断了自动退回轮询'),
          ]),
          h('div', { className: 'qqb-adv', key: 'b' }, [
            h('label', { className: 'qqb-check', key: 'en' }, [
              h('input', { type: 'checkbox', key: 'c', checked: t.wsEnabled === true, onChange: onField('wsEnabled') }),
              h('span', { key: 'l' }, '启用推送（消息即时到达，延迟从约 1 秒降到接近 0）'),
            ]),
            h('label', { className: 'qqb-field', key: 'url' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'WS 地址（留空 = 保持原样）'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'text',
                title: '留空 = 保持原样（清空输入框不会清掉已保存的地址）',
                placeholder: 'ws://127.0.0.1:3001/',
                value: t.wsUrl || '',
                onChange: onField('wsUrl')
              }),
            ]),
            h('label', { className: 'qqb-field', key: 'tk' }, [
              h('span', { className: 'qqb-field-label', key: 'l' }, 'WS token'),
              h('input', {
                className: 'qqb-input', key: 'i', type: 'password',
                placeholder: '留空 = 保持原样',
                value: t.wsToken || '',
                onChange: onField('wsToken')
              }),
            ]),
            h('div', { className: 'qqb-tools', key: 'btn' }, [
              h('button', { className: 'qqb-btn', key: 'd', onClick: detectWs, disabled: busy }, '自动发现（读 SnowLuma 配置）'),
              h('span', { className: 'qqb-note', key: 'n' }, 'SnowLuma 的 WS 端口/token 在 config/onebot_*.json 的 wsServers 里，跟 HTTP 那套不是同一个 token'),
            ]),
          ]),
        ])
      }

      /** 「配置」分区：HTTP API + WebSocket 两条链路放在一起（0.15.0）。 */
      function renderConfig() {
        return h('div', { className: 'qqb-pane', key: 'config' }, [
          renderWs(),
          renderPush(),
        ])
      }

      /** tab 角标：绑了几个、开着没有、记住几个人 —— 不点进去也知道大概。 */
      function tabBadge(id) {
        if (id === 'binding') {
          var n = Object.keys(draft.private || {}).length + Object.keys(draft.group || {}).length
          return n === 0 ? '' : String(n)
        }
        if (id === 'proactive') {
          return data && data.config && data.config.proactiveEnabled === true ? '开' : '关'
        }
        if (id === 'memory') {
          var c = data && data.memory ? Number(data.memory.count) || 0 : 0
          return c === 0 ? '' : String(c)
        }
        if (id === 'readers') {
          var r = totalReaders()
          return r === 0 ? '' : String(r)
        }
        if (id === 'quarantine' && quarantine !== null && quarantine !== undefined) {
          var qn = Math.max(0, Number(quarantine.total) || 0)
          return qn === 0 ? '' : String(qn)
        }
        return ''
      }

      /** 概览里的一行「项目 + 说明」。 */
      function line(title, text) {
        return h('div', { className: 'qqb-mem-row', key: 'l-' + title, style: { alignItems: 'baseline' } }, [
          h('span', { className: 'qqb-mem-key', key: 't', style: { flex: '0 0 76px' } }, title),
          h('span', { className: 'qqb-hint-inline', key: 'x' }, text),
        ])
      }

      /**
       * 概览 —— 一进来先看「现在是什么状态」，而不是先看到一堆输入框。
       * 数字读服务端已保存的配置（data.config），不读编辑态：改了还没保存就不该显示成已生效。
       */
      function renderOverview() {
        var cfg = (data && data.config) || {}
        var mem = (data && data.memory) || {}
        var pro = (data && data.proactive) || {}
        var merge = (data && data.merge) || {}
        var ws = data && data.ws ? data.ws : null
        var rt = data && data.runtime ? data.runtime : {}

        var privateKeys = Object.keys(draft.private || {})
        var boundPrivate = privateKeys.filter(function (k) {
          var route = draft.private[k]
          return String(route && route.sessionId ? route.sessionId : '') !== ''
        }).length
        var groupKeys = Object.keys(draft.group || {})

        var poolCount = 0
        if (Array.isArray(merge.pools)) {
          for (var i = 0; i < merge.pools.length; i++) poolCount += Number(merge.pools[i].count) || 0
        }

        var peers = pro !== null && Array.isArray(pro.peers) ? pro.peers : []
        var todayCount = 0
        for (var j = 0; j < peers.length; j++) todayCount += Number(peers[j].countToday) || 0

        var targets = Array.isArray(cfg.proactiveTargets) ? cfg.proactiveTargets : []
        var whom = targets.length === 0 ? '所有已绑私聊' : '指定的 ' + String(targets.length) + ' 人'

        // 读者相关：条数读草稿（跟「绑定」角标一致），积压读服务端 /state（那是真数据）
        var readerCount = totalReaders()
        var backlogList = data && Array.isArray(data.backlog) ? data.backlog : []
        var backlogTotal = 0
        for (var b = 0; b < backlogList.length; b++) backlogTotal += Number(backlogList[b].count) || 0

        function stat(label, value, hint, to) {
          var clickable = typeof to === 'string' && to !== ''
          return h('div', {
            className: 'qqb-stat' + (clickable && to === tab ? ' on' : ''),
            key: 's-' + label,
            style: clickable ? { cursor: 'pointer' } : undefined,
            onClick: clickable ? function () { setTab(to) } : undefined,
            title: clickable ? '点开这一块' : '',
          }, [
            h('div', { className: 'qqb-stat-n', key: 'n' }, String(value)),
            h('div', { className: 'qqb-stat-l', key: 'l' }, label),
            hint === '' ? null : h('div', { className: 'qqb-hint-inline', key: 'h' }, hint),
          ])
        }

        var quick = ['binding', 'readers', 'stance', 'proactive', 'memory'].map(function (id) {
          var label = id
          for (var k = 0; k < TABS.length; k++) {
            if (TABS[k][0] === id) label = TABS[k][1]
          }
          return h('button', { className: 'qqb-btn', key: 'q-' + id, onClick: function () { setTab(id) } }, label)
        })

        return h('div', { className: 'qqb-pane', key: 'overview' }, [
          h('div', { className: 'qqb-stats', key: 'stats' }, [
            stat('私聊绑定', boundPrivate + ' / ' + privateKeys.length, '已绑会话 / 总绑定', 'binding'),
            stat('群聊绑定', String(groupKeys.length), groupKeys.length === 0 ? '没绑群' : '被 @ 才回', 'binding'),
            stat('读者', String(readerCount),
              readerCount === 0 ? '没有只读观察者' : (backlogTotal > 0 ? backlogTotal + ' 条未取积压' : '只读观察者'), 'readers'),
            stat('今天主动', todayCount + ' / ' + String(Number(cfg.proactiveDailyMax) || 1),
              cfg.proactiveEnabled === true ? '开着 · ' + whom : '开关关着', 'proactive'),
            stat('记住的人', String(Number(mem.count) || 0), cfg.memoryEnabled === false ? '记忆关着' : '', 'memory'),
            stat('待合并', String(poolCount),
              merge.settings ? '窗口 ' + String(merge.settings.windowMs) + 'ms' : '', 'stance'),
            stat('推送', ws !== null && ws.connected === true ? '已连' : '未连',
              ws !== null && ws.connected === true ? '实时收消息' : '走轮询兜底', 'ws'),
          ]),
          h('div', { className: 'qqb-card', key: 'now' }, [
            h('div', { className: 'qqb-card-head', key: 'h' }, [
              h('span', { className: 'qqb-card-title', key: 't' }, '现在在跑什么'),
              h('span', { className: 'qqb-hint-inline', key: 'n' }, '改参数去上面那排里点'),
            ]),
            h('div', { className: 'qqb-mem', key: 'b' }, [
              line('这版代码', rt.version
                ? 'v' + String(rt.version) + ' · 进程 ' + String(rt.pid) + ' · 起于 ' + fmtWhen(Date.parse(String(rt.bootAt || '')))
                : '读不到版本号（package.json 缺失？）'),
              line('连接', 'HTTP ' + (cfg.onebotHttp ? String(cfg.onebotHttp) : '（未配置）') +
                ' · WS ' + (cfg.wsEnabled === false ? '关着' : (ws !== null && ws.connected === true ? '已连' : '未连'))),
              line('绑定', boundPrivate === 0
                ? '还没绑任何私聊 —— 消息会一律忽略'
                : boundPrivate + ' 个私聊已绑会话；没绑的号发来消息一律忽略'),
              line('读者', readerCount === 0
                ? '没有只读观察者：消息只进写者会话'
                : readerCount + ' 个只读绑定' + (backlogTotal > 0 ? '；' + backlogTotal + ' 条积压还没人取走' : '；没有积压')),
              line('回复手感', '合并窗口 ' + String(Number(cfg.mergeWindowMs) || 0) + 'ms + 回复前静默 ' +
                String(Number(cfg.replyQuietMs) || 0) + 'ms（两者叠加；都归零就是来一条回一条）'),
              line('沉默权', cfg.closureEnabled === false ? '收尾判断关着' : '双方都收尾时，她会用 qq_close 结束这一场'),
              line('关系记忆', cfg.memoryEnabled === false ? '关着，回复里不会多出「关于他：…」' : '开着，每回合正文前带一小段「关于他」'),
              line('主动搭话', cfg.proactiveEnabled === true
                ? '开着：空闲 ' + String(cfg.proactiveIdleHours) + ' 小时、每天 ' + String(cfg.proactiveDailyMax) +
                  ' 次、' + String(cfg.proactiveQuietFrom) + '–' + String(cfg.proactiveQuietTo) + ' 静默，对' + whom + '生效'
                : '关着（不会自己发消息）'),
              h('div', { className: 'qqb-tools', key: 'q', style: { marginTop: '6px', borderTop: '0', padding: '6px 0 0' } }, quick),
            ]),
          ]),
        ])
      }

      // 分区内容：一次只渲染一块（所有 card 的 key 各自独立，切换不会互相干扰）
      var pane
      if (tab === 'binding') {
        pane = h('div', { className: 'qqb-pane', key: 'binding' }, [
          renderTable('private', '私聊', '填 QQ 号，比如 1000000001'),
          renderTable('group', '群聊', '填群号'),
        ])
      } else if (tab === 'readers') {
        pane = renderReaders()
      } else if (tab === 'quarantine') {
        pane = renderQuarantine()
      } else if (tab === 'stance') {
        pane = h('div', { className: 'qqb-pane', key: 'stance' }, renderStance())
      } else if (tab === 'proactive') {
        pane = renderProactive()
      } else if (tab === 'memory') {
        pane = h('div', { className: 'qqb-pane', key: 'memory' }, renderMemory())
      } else if (tab === 'ws') {
        pane = renderConfig()
      } else if (tab === 'schedule') {
        pane = renderSchedules()
      } else if (tab === 'advanced') {
        pane = renderAdvanced()
      } else {
        pane = renderOverview()
      }

      return h('div', { className: 'qqb-wrap' }, [
        h('div', { className: 'qqb-head', key: 'head' }, [
          h('div', { key: 'l' }, [
            h('div', { className: 'qqb-title-row', key: 't' }, [
              h('span', { className: 'qqb-title', key: 'ti' }, 'QQ 桥接'),
              selfBadge(data.self),
              wsBadge(data.ws)
            ]),
            h('div', { className: 'qqb-note', key: 'n' }, '每个号绑定一个 DSH 会话。没绑定的消息一律忽略（不会乱投到别的会话）。'),
          ]),
          h('div', { key: 'r', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            h('button', { className: 'qqb-btn', key: 'r', onClick: reload, disabled: busy }, '重新载入'),
            h('button', { className: 'qqb-btn primary', key: 's', onClick: save, disabled: busy }, busy ? '处理中…' : '保存'),
          ]),
        ]),
        // 总开关只在配置文件里（index.js 加载时读一次），所以这里只报状态、不给按钮 ——
        // 放个可点的开关会让人以为点了就生效，实际得重启 DSH。
        data.config && data.config.enabled === false
          ? h('div', { className: 'qqb-warn', key: 'off' }, [
              h('span', { key: 'i' }, '⚠'),
              h('span', { key: 't' }, '插件已停用：配置文件里的 enabled 是 false，收发和工具都不工作。改回 true 后重启 DSH 才会恢复。'),
            ])
          : null,
        msg === '' ? null : h('div', {
          className: 'qqb-msg ' + (msg.indexOf('失败') >= 0 || msg.indexOf('不对') >= 0 ? 'err' : 'ok'),
          key: 'msg',
        }, msg),
        h('div', { className: 'qqb-tabs', key: 'tabs' }, TABS.map(function (item) {
          var id = item[0]
          var badge = tabBadge(id)
          return h('button', {
            className: 'qqb-tab' + (tab === id ? ' on' : ''),
            key: 'tab-' + id,
            onClick: function () { setTab(id) },
          }, [
            h('span', { key: 'l' }, item[1]),
            badge === '' ? null : h('span', { className: 'qqb-tab-badge', key: 'b' }, badge),
          ])
        })),
        pane,
        h('div', { className: 'qqb-note', key: 'cwd' }, '会话来源工作区：' + String(data.config && data.config.workspaceCwd ? data.config.workspaceCwd : '（未设置）')),
      ])
    }

    // ---- 右侧边栏：当前会话的 QQ 权限 -------------------------------------

    var PERMS_ID = 'dsh-onebot-channel/qq-permissions'
    var PERMS_KIND = 'qq-permissions'

    function permKindLabel(kind) {
      return kind === 'group' ? '群聊' : '私聊'
    }

    function permModeLabel(mode) {
      if (mode === 'wake') return 'wake（唤醒）'
      if (mode === 'ambient') return 'ambient（非@唤醒）'
      if (mode === 'backlog') return 'backlog（积压）'
      if (mode === 'muted') return 'muted（静音）'
      return 'off（关闭）'
    }

    function shortSessionId(id) {
      var text = String(id || '')
      return text.length > 26 ? text.slice(0, 12) + '…' + text.slice(-10) : text
    }

    /** 服务器还没有 /session-state 时的兼容推导（用整份 /state 过滤当前会话）。 */
    function deriveSessionState(state, sessionId) {
      var writer = []
      var readers = []
      var routes = state && state.routes ? state.routes : { private: {}, group: {} }
      var readerTable = state && state.readers ? state.readers : { private: {}, group: {} }
      var kinds = ['private', 'group']
      for (var i = 0; i < kinds.length; i += 1) {
        var kind = kinds[i]
        var routesOfKind = routes[kind] || {}
        for (var peerId in routesOfKind) {
          if (Object.prototype.hasOwnProperty.call(routesOfKind, peerId) &&
              routesOfKind[peerId] && String(routesOfKind[peerId].sessionId || '') === sessionId) {
            writer.push({ kind: kind, peerId: peerId, prefix: String(routesOfKind[peerId].prefix || ''), wakeMode: String(routesOfKind[peerId].wakeMode || 'wake') })
          }
        }
        var readersOfKind = readerTable[kind] || {}
        for (var readerPeer in readersOfKind) {
          if (!Object.prototype.hasOwnProperty.call(readersOfKind, readerPeer)) continue
          var list = readersOfKind[readerPeer]
          if (!Array.isArray(list)) continue
          for (var j = 0; j < list.length; j += 1) {
            if (String(list[j] && list[j].sessionId || '') !== sessionId) continue
            readers.push({ kind: kind, peerId: readerPeer, wakeMode: list[j].wakeMode || 'muted' })
          }
        }
      }
      return { revision: state ? state.revision : undefined, writer: writer, readers: readers, ws: state ? state.ws : null }
    }

    function QqPermissionsBody(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''
      var dataState = useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errorState = useState('')
      var errorText = errorState[0]
      var setError = errorState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var messageState = useState('')
      var message = messageState[0]
      var setMessage = messageState[1]
      var formState = useState({ kind: 'private', peerId: '', role: 'reader', mode: 'muted' })
      var form = formState[0]
      var setForm = formState[1]

      function load() {
        if (sessionId === '') {
          setError('没有拿到当前会话 ID（右栏 tab 需要会话上下文）')
          return
        }
        setBusy(true)
        setError('')
        apiGet('/session-state?sessionId=' + encodeURIComponent(sessionId)).then(function (next) {
          setData(next)
          setBusy(false)
        }).catch(function (failure) {
          if (failure && failure.status === 404) {
            return apiGet('/state').then(function (state) {
              setData(deriveSessionState(state, sessionId))
              setBusy(false)
            })
          }
          setError(errText(failure))
          setBusy(false)
        })
      }

      useEffect(function () { load() }, [sessionId])

      function mutate(payload) {
        setBusy(true)
        setError('')
        setMessage('')
        var body = { sessionId: sessionId }
        if (data && typeof data.revision === 'number') body.expectedRevision = data.revision
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key]
        }
        apiPost('/session-save', body).then(function (next) {
          setData(next)
          setBusy(false)
          setMessage('已更新')
        }).catch(function (failure) {
          setBusy(false)
          if (failure && failure.status === 409) load()
          else setError(errText(failure))
        })
      }

      function addBinding() {
        var peerId = String(form.peerId || '').trim()
        if (!/^\d{1,20}$/.test(peerId)) {
          setError('QQ 号 / 群号必须是纯数字')
          return
        }
        if (form.role === 'writer') {
          mutate({ action: 'add-writer', kind: form.kind, peerId: peerId, wakeMode: form.mode })
        } else {
          mutate({ action: 'add-reader', kind: form.kind, peerId: peerId, wakeMode: form.mode })
        }
      }

      var writer = data && Array.isArray(data.writer) ? data.writer : []
      var readers = data && Array.isArray(data.readers) ? data.readers : []
      var wsText = data && data.ws && data.ws.connected === true ? 'OneBot 已连接' : 'OneBot 状态未知'

      function writerRow(item) {
        return h('div', { className: 'qqb-perm-row', key: 'w-' + item.kind + '-' + item.peerId }, [
          h('div', { className: 'qqb-perm-main', key: 'm' }, [
            h('span', { className: 'qqb-perm-id', key: 'id' }, permKindLabel(item.kind) + ' ' + item.peerId),
            h('span', { className: 'qqb-perm-sub', key: 'sub' }, item.prefix ? ('正文前缀：' + item.prefix) : 'writer（可读可写）'),
          ]),
          h('div', { className: 'qqb-perm-actions', key: 'a' }, [
            h('select', {
              className: 'qqb-select',
              key: 'mode',
              value: item.wakeMode || 'wake',
              disabled: busy,
              onChange: function (event) {
                mutate({ action: 'set-writer-mode', kind: item.kind, peerId: item.peerId, wakeMode: event.target.value })
              },
            }, ['wake', 'ambient', 'backlog', 'muted', 'off'].map(function (mode) {
              return h('option', { value: mode, key: mode }, permModeLabel(mode))
            })),
            h('button', {
              className: 'qqb-btn danger',
              key: 'rm',
              disabled: busy,
              onClick: function () { mutate({ action: 'remove-writer', kind: item.kind, peerId: item.peerId }) },
            }, '解绑'),
          ]),
        ])
      }

      function readerRow(item) {
        return h('div', { className: 'qqb-perm-row', key: 'r-' + item.kind + '-' + item.peerId }, [
          h('div', { className: 'qqb-perm-main', key: 'm' }, [
            h('span', { className: 'qqb-perm-id', key: 'id' }, permKindLabel(item.kind) + ' ' + item.peerId),
            h('span', { className: 'qqb-perm-sub', key: 'sub' }, 'reader（只读，不能 qq_send）'),
          ]),
          h('div', { className: 'qqb-perm-actions', key: 'a' }, [
            h('select', {
              className: 'qqb-select',
              key: 'mode',
              value: item.wakeMode || 'muted',
              disabled: busy,
              onChange: function (event) {
                mutate({ action: 'set-reader-mode', kind: item.kind, peerId: item.peerId, wakeMode: event.target.value })
              },
            }, ['wake', 'backlog', 'muted', 'off'].map(function (mode) {
              return h('option', { value: mode, key: mode }, permModeLabel(mode))
            })),
            h('button', {
              className: 'qqb-btn danger',
              key: 'rm',
              disabled: busy,
              onClick: function () { mutate({ action: 'remove-reader', kind: item.kind, peerId: item.peerId }) },
            }, '解除'),
          ]),
        ])
      }

      var writerPane = writer.length === 0
        ? h('div', { className: 'qqb-perm-empty', key: 'empty' }, '这个会话还没有写目标。')
        : h('div', { className: 'qqb-perm-sec', key: 'list' }, writer.map(writerRow))
      var readerPane = readers.length === 0
        ? h('div', { className: 'qqb-perm-empty', key: 'empty' }, '这个会话没有只读订阅。')
        : h('div', { className: 'qqb-perm-sec', key: 'list' }, readers.map(readerRow))

      return h('div', { className: 'qqb-wrap' }, [
        h('div', { className: 'qqb-head', key: 'head' }, [
          h('div', { className: 'qqb-title-row', key: 't' }, [
            h('span', { className: 'qqb-title', key: 'ti' }, 'QQ 权限'),
            h('span', { className: 'qqb-self', key: 'sess', title: sessionId }, [
              h('span', { key: 'k' }, '会话 '),
              h('span', { className: 'qqb-self-uin', key: 'u' }, shortSessionId(sessionId)),
            ]),
            h('span', { className: 'qqb-tag', key: 'ws' }, wsText),
          ]),
          h('div', { key: 'r', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            h('button', { className: 'qqb-btn', key: 'reload', onClick: load, disabled: busy }, '刷新'),
          ]),
        ]),
        h('div', { className: 'qqb-note', key: 'desc' }, '这里只显示当前会话的 QQ 关系：writer 可收发，reader 只读；一个 peer 最多一个 writer。'),
        errorText === '' ? null : h('div', { className: 'qqb-err', key: 'err' }, errorText),
        message === '' ? null : h('div', { className: 'qqb-msg ok', key: 'msg' }, message),
        h('div', { className: 'qqb-card', key: 'writers' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '作为 writer（可收发）'),
            h('span', { className: 'qqb-tag', key: 'c' }, String(writer.length) + ' 个'),
          ]),
          writerPane,
        ]),
        h('div', { className: 'qqb-card', key: 'readers' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '作为 reader（只读）'),
            h('span', { className: 'qqb-tag', key: 'c' }, String(readers.length) + ' 个'),
          ]),
          readerPane,
        ]),
        h('div', { className: 'qqb-card', key: 'add' }, [
          h('div', { className: 'qqb-card-head', key: 'h' }, [
            h('span', { className: 'qqb-card-title', key: 't' }, '添加绑定'),
          ]),
          h('div', { className: 'qqb-perm-form', key: 'f' }, [
            h('select', {
              className: 'qqb-select', key: 'kind', value: form.kind, disabled: busy,
              onChange: function (event) { setForm({ kind: event.target.value, peerId: form.peerId, role: form.role, mode: form.mode }) },
            }, [h('option', { value: 'private', key: 'p' }, '私聊'), h('option', { value: 'group', key: 'g' }, '群聊')]),
            h('input', {
              className: 'qqb-input', key: 'peer', placeholder: 'QQ 号 / 群号', value: form.peerId, disabled: busy,
              onChange: function (event) { setForm({ kind: form.kind, peerId: event.target.value, role: form.role, mode: form.mode }) },
            }),
            h('select', {
              className: 'qqb-select', key: 'role', value: form.role, disabled: busy,
              onChange: function (event) {
                var role = event.target.value
                setForm({ kind: form.kind, peerId: form.peerId, role: role, mode: role === 'writer' ? 'wake' : 'muted' })
              },
            }, [h('option', { value: 'reader', key: 'r' }, 'reader 只读'), h('option', { value: 'writer', key: 'w' }, 'writer 读写')]),
            h('select', {
              className: 'qqb-select', key: 'mode', value: form.mode, disabled: busy,
              onChange: function (event) { setForm({ kind: form.kind, peerId: form.peerId, role: form.role, mode: event.target.value }) },
            }, ['wake', 'backlog', 'muted', 'off'].map(function (mode) {
              return h('option', { value: mode, key: mode }, permModeLabel(mode))
            })),
            h('button', { className: 'qqb-btn primary', key: 'add', onClick: addBinding, disabled: busy }, busy ? '处理中…' : '添加'),
          ]),
          h('div', { className: 'qqb-perm-note', key: 'n' }, 'writer 拥有该 peer 的读写权限，也可设置接收模式；reader 只读，不能发 QQ。全局路由、token 等在「设置 → QQ 桥接」。'),
        ]),
      ])
    }

    // ---- 插件入口 ---------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        ensureStyles()
        return function () {
          var el = document.getElementById('dsh-onebot-channel-style')
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-onebot-channel: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'qq-bridge',
          order: 47,
          locale: NS,
          label: function () { return 'QQ 桥接' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          var withCtx = { bridgeCtx: ctx }
          for (var key in p) {
            if (Object.prototype.hasOwnProperty.call(p, key)) withCtx[key] = p[key]
          }
          return h(SectionErrorBoundary, null, h(QqBridgeSection, withCtx))
        })
      })

      // 右侧边栏的 per-session QQ 权限页。服务不存在时（老客户端/测试桩）静默跳过，
      // 不影响设置页。
      if (ctx.sidebarRightTabs !== undefined && ctx.sidebarRightTabs !== null) {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: PERMS_ID,
            kind: PERMS_KIND,
            title: function () { return 'QQ 权限' },
            guide: [{
              id: 'qq-permissions',
              order: 60,
              title: function () { return 'QQ 权限' },
              description: function () { return '当前会话的 QQ 读写权限' },
            }],
          })
        }, 'dsh-onebot-channel: qq-permissions tab type')

        ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: PERMS_ID,
          }, function (props) {
            return h(QqPermissionsBody, props)
          })
        })
      }
    }

    var NS = 'dsh-onebot-channel'

    module.exports = {
      name: 'qq-bridge',
      inject: ['slots', 'sidebarRightTabs'],
      apply: apply,
    }
    return module.exports
  },
})
