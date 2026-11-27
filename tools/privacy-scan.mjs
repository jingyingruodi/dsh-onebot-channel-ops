#!/usr/bin/env node
/**
 * 发布前隐私检查：扫描 git 已跟踪的文本文件。
 *
 * 安全设计：仓库内不保存真实 QQ/群号/域名/人名等匹配值。
 * 真实匹配表放在仓库外的私有文件（默认 ~/.dsh/qq-privacy-patterns.json，
 * 或环境变量 PRIVACY_PATTERNS_FILE 指向的文件），格式：
 *
 * [
 *   { "id": "real-qq", "severity": "high", "pattern": "…", "note": "真实 QQ" }
 * ]
 *
 * 内置只放通用凭据/路径模式；默认输出不打印命中原文，避免 CI 日志二次泄漏。
 *
 * 用法：
 *   node tools/privacy-scan.mjs
 *   node tools/privacy-scan.mjs --json
 *   node tools/privacy-scan.mjs --show-excerpt   # 仅本机使用
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BUILTIN_PATTERNS = [
  { id: 'secret-like', severity: 'high', pattern: '(?:token|password|passwd|secret|api[_-]?key)\\s*[:=]\\s*[\'"]?[A-Za-z0-9_./+=-]{20,}', note: '疑似凭据' },
  { id: 'private-path', severity: 'medium', pattern: 'C:\\\\Users\\\\[^\\\\\\s]+|/home/[^/\\s]+', note: '私有用户路径' }
]

const SKIP_FILES = new Set(['tools/privacy-scan.mjs', 'docs/隐私审查报告-20261124.md', 'LICENSE', 'LICENCE', 'COPYING', 'lib/sensitive.js'])

function loadExternalPatterns() {
  const path = process.env.PRIVACY_PATTERNS_FILE || join(homedir(), '.dsh', 'qq-privacy-patterns.json')
  if (!existsSync(path)) return { path, patterns: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const patterns = Array.isArray(raw)
      ? raw.filter((item) => item && typeof item.pattern === 'string' && item.pattern !== '')
        .map((item) => ({
          id: String(item.id ?? 'external'),
          severity: String(item.severity ?? 'high'),
          pattern: String(item.pattern),
          note: String(item.note ?? '外部隐私模式')
        }))
      : []
    return { path, patterns }
  } catch {
    return { path, patterns: [], error: `无法读取隐私模式文件：${path}` }
  }
}

const textExtensions = new Set(['.md', '.json', '.yml', '.yaml', '.js', '.mjs', '.ts', '.txt', '.sh', '.ps1', '.html', '.css', '.svg'])
const licenseNames = new Set(['LICENSE', 'LICENCE', 'COPYING'])

function main() {
  const json = process.argv.includes('--json')
  const showExcerpt = process.argv.includes('--show-excerpt')
  const external = loadExternalPatterns()
  const patterns = [...BUILTIN_PATTERNS, ...external.patterns].map((item) => ({
    ...item,
    re: new RegExp(item.pattern, 'g')
  }))
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && !SKIP_FILES.has(file))
    .filter((file) => {
      const base = file.slice(file.lastIndexOf('/') + 1)
      const dot = base.lastIndexOf('.')
      return textExtensions.has(dot >= 0 ? base.slice(dot) : '') || licenseNames.has(base)
    })
  const findings = []
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      for (const pattern of patterns) {
        pattern.re.lastIndex = 0
        if (!pattern.re.test(lines[index])) continue
        findings.push({
          file,
          line: index + 1,
          pattern: pattern.id,
          severity: pattern.severity,
          note: pattern.note,
          ...(showExcerpt ? { excerpt: lines[index].trim().slice(0, 180) } : {})
        })
      }
    }
  }
  const summary = {
    ok: findings.length === 0,
    files: files.length,
    externalPatterns: external.path,
    externalPatternCount: external.patterns.length,
    count: findings.length,
    findings,
    ...(external.error ? { error: external.error } : {})
  }
  if (json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`隐私扫描：${files.length} 个文本文件，${findings.length} 处命中（外部模式 ${external.patterns.length} 条）`)
    if (external.error) console.log(external.error)
    for (const finding of findings) {
      console.log(`${finding.severity.toUpperCase()} ${finding.file}:${finding.line} [${finding.pattern}] ${finding.note}`)
      if (finding.excerpt) console.log(`  ${finding.excerpt}`)
    }
    if (findings.length === 0) console.log('未发现命中。')
    console.log('说明：仓库内不保存真实匹配值；真实模式表请放 ~/.dsh/qq-privacy-patterns.json。')
  }
  process.exitCode = findings.length === 0 ? 0 : 1
}

main()
