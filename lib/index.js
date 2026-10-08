/**
 * dsh-plugin-skill-updater —— 宿主侧(运行在 DSH 宿主进程中)
 *
 * 职责:
 *   1) DSH 启动后自动检查「已安装插件(npm 包)」与「本地 Skill」是否有更新;
 *      未发布到网上的(link:/file:/git 来源、或 npm 上查不到)一律跳过。
 *   2) 结果经 /dsh-plugin-skill-updater/* 路由交给 Web 端弹窗。
 *   3) 用户确认后后台更新:插件走 DSH 自带 CLI 的 `plugin update`(与手工命令同一路径);
 *      Skill 经官方 updateManifestUrl + 资产 sha256 校验后原子替换(带备份)。
 *
 * 安全:所有路由都过 DSH 的浏览器信任栅栏(connection.requestRejection);
 *       写操作额外要求回环来源(Host 必须是 127.0.0.1 / localhost / [::1])。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ROUTE_PREFIX = '/dsh-plugin-skill-updater'
const CLIENT_JS_PATH = path.join(PACKAGE_ROOT, 'assets', 'skill-updater.js')
const STATE_FILE_NAME = '.dsh-skill-updater.json'
const MIN_RELEASE_AGE_HOURS = 24 // 与 DSH 内置 pnpm 的发布冷却期保持一致
const HTTP_TIMEOUT_MS = 30000
// 直连超时:比 undici 默认连接超时(约 10s)短,让被墙/丢包的地址尽快落到系统代理兜底通道,
// 不至于让单个请求拖住整轮检查。
const DIRECT_TIMEOUT_MS = 8000
// 并发度:registry / Skill 上游查询都并发进行,避免串行累加超时。
const REGISTRY_CONCURRENCY = 6
const SKILL_CONCURRENCY = 4
const JOB_LOG_LIMIT = 500

// 没有 updateManifestUrl 的 Skill:按目录名在这里登记上游来源;认不出来的跳过,不做猜测。
const CONTENT_SKILL_SOURCES = {
  'ppt-design-skill': {
    kind: 'content',
    versionUrl: 'https://raw.githubusercontent.com/sunchaokun/PPT-Design-Skill/main/skill.json',
    versionPointer: 'version',
    contentUrl: 'https://raw.githubusercontent.com/sunchaokun/PPT-Design-Skill/main/skill/SKILL.md',
    localContent: 'SKILL.md',
    update: 'installer',
    repoArchive: 'https://codeload.github.com/sunchaokun/PPT-Design-Skill/zip/refs/heads/main',
    archiveInner: 'PPT-Design-Skill-main',
    installer: 'installer/install.py',
    platform: 'deepseek-harness',
    sizeWarning: '约 175 MB',
    homepage: 'https://github.com/sunchaokun/PPT-Design-Skill',
  },
}

/* ===== 1. semver ===== */

function mkSemver(major, minor, patch, pre) {
  const p = pre || ''
  return { major, minor, patch, pre: p, raw: `${major}.${minor}.${patch}${p ? '-' + p : ''}` }
}

function parseSemver(input) {
  if (!input) return null
  let s = String(input).trim()
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1)
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (!m) return null
  return mkSemver(Number(m[1]), Number(m[2]), Number(m[3]), m[4] || '')
}

function cmpSemver(a, b) {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return Math.sign(a.major - b.major)
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor)
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch)
  if (a.pre === b.pre) return 0
  if (!a.pre) return 1 // 正式版 > 预发布版
  if (!b.pre) return -1
  const ai = a.pre.split('.')
  const bi = b.pre.split('.')
  const n = Math.min(ai.length, bi.length)
  for (let i = 0; i < n; i++) {
    const x = ai[i]
    const y = bi[i]
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d) return Math.sign(d)
    } else if (xNum) {
      return -1
    } else if (yNum) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return Math.sign(ai.length - bi.length)
}

function satisfiesComparator(v, rawToken) {
  let t = String(rawToken || '').trim()
  if (!t) return true
  if (t === '*' || t === 'x' || t === 'X' || t === 'latest') return true

  let op = ''
  for (const cand of ['>=', '<=', '^', '~', '>', '<', '=']) {
    if (t.startsWith(cand)) {
      op = cand
      t = t.slice(cand.length).trim()
      break
    }
  }
  if (!t) return true
  if (t === '*' || t === 'x' || t === 'X') return true

  // 通配符形式:1.x / 1.2.x
  const parts = t.split('.')
  const wildIndex = parts.findIndex((x) => x === '*' || x === 'x' || x === 'X' || x === '')
  if (wildIndex >= 0) {
    const base = []
    for (let i = 0; i < wildIndex; i++) {
      if (!/^\d+$/.test(parts[i])) return true // 无法解析 → 不参与排除
      base.push(Number(parts[i]))
    }
    while (base.length < 3) base.push(0)
    if (wildIndex === 0) return true
    const lo = mkSemver(base[0], base[1], base[2], '')
    const hi =
      wildIndex === 1 ? mkSemver(base[0] + 1, 0, 0, '') : mkSemver(base[0], base[1] + 1, 0, '')
    return cmpSemver(v, lo) >= 0 && cmpSemver(v, hi) < 0
  }

  const sv = parseSemver(t)
  if (!sv) return true // 无法解析的量词不参与排除
  const c = cmpSemver(v, sv)
  if (op === '^') {
    if (c < 0) return false
    let hi
    if (sv.major > 0) hi = mkSemver(sv.major + 1, 0, 0, '')
    else if (sv.minor > 0) hi = mkSemver(0, sv.minor + 1, 0, '')
    else hi = mkSemver(0, 0, sv.patch + 1, '')
    return cmpSemver(v, hi) < 0
  }
  if (op === '~') {
    if (c < 0) return false
    return cmpSemver(v, mkSemver(sv.major, sv.minor + 1, 0, '')) < 0
  }
  if (op === '>=') return c >= 0
  if (op === '>') return c > 0
  if (op === '<=') return c <= 0
  if (op === '<') return c < 0
  return c === 0
}

function satisfiesRange(version, range) {
  const v = parseSemver(version)
  if (!v) return false
  if (!range || !String(range).trim()) return true
  for (const alt of String(range).split('||')) {
    const set = alt.trim()
    if (!set) return true
    const tokens = set.split(/\s+/).filter(Boolean)
    if (tokens.every((tk) => satisfiesComparator(v, tk))) return true
  }
  return false
}

// 声明范围是否像「npm 上发布的版本范围」。link:/file:/git/github:/http/相对路径等本地或
// 非 npm 来源一律不算(自己写的、没发布到网上的要跳过)。
function looksLikeRegistryRange(spec) {
  if (!spec || typeof spec !== 'string') return false
  const s = spec.trim()
  if (!s) return false
  if (/^(link|file|portal|workspace|git|git\+|github|gitlab|bitbucket|https?|npm):/i.test(s)) return false
  if (/^[./\\]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return false
  // 其余(semver 范围或 dist-tag)都当成「已发布来源」,交给 registry 复核:
  // 查不到(404)才算未发布,对应「自己写的、没发布到网上的包」。
  return true
}

/* ===== 2. 宿主环境定位 ===== */

function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  for (const a of process.argv) {
    if (typeof a === 'string' && /[\\/]profiles[\\/][^\\/]+$/.test(a)) return a
  }
  const name = process.env.DSH_PROFILE || 'desktop'
  return path.join(resolveDshHome(), 'profiles', name)
}

/** 桌面端宿主进程的 argv 里带着 dsh-desktop-host/lib/index.js,clijs 与它同目录。 */
function resolveCliJs() {
  for (const a of process.argv) {
    if (typeof a === 'string' && /dsh-desktop-host[\\/]lib[\\/](?:index|cli)\.js$/.test(a)) {
      const p = path.join(path.dirname(a), 'cli.js')
      if (fs.existsSync(p)) return p
    }
  }
  for (const a of process.argv) {
    if (typeof a === 'string' && /app\.asar[\\/]dsh$/.test(a)) {
      const p = path.join(a, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

/** <安装根>\resources\runtime\cli\bin\dsh.cmd —— 由可执行文件位置推导。 */
function resolveCliShim() {
  try {
    const installRoot = path.dirname(process.execPath)
    const p = path.join(installRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
    if (fs.existsSync(p)) return p
  } catch (err) {}
  return null
}

function resolveBundledPython() {
  const p = path.join(
    resolveDshHome(),
    'dsh-runtimes',
    'dsh-primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  )
  return fs.existsSync(p) ? p : null
}

/* ===== 3. 文件 / 网络小工具 ===== */

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return null
  }
}

function writeJsonFile(file, obj) {
  try {
    // 不写 BOM:带 BOM 的 JSON 会让严格解析器报错
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), { encoding: 'utf8' })
    return true
  } catch (err) {
    return false
  }
}

function readState(home) {
  const s = readJsonFile(path.join(home, STATE_FILE_NAME))
  if (!s || typeof s !== 'object') return { skills: {} }
  if (!s.skills || typeof s.skills !== 'object') s.skills = {}
  return s
}

function writeState(home, state) {
  state.lastCheckUtc = new Date().toISOString()
  writeJsonFile(path.join(home, STATE_FILE_NAME), state)
}

/** 把最近一次检查的宿主信息落盘,便于不打开界面也能排查(路由需要会话鉴权)。 */
function recordLastCheck(home, skillState) {
  skillState.lastCheck = {
    at: new Date().toISOString(),
    phase: state.phase,
    updateCount: state.items.length,
    skipped: state.skipped.length,
    profileDir: resolveProfileDir(),
    cli: resolveCliJs() || resolveCliShim() || null,
    error: state.error || null,
  }
  writeState(home, skillState)
}

function psQuote(s) {
  return String(s).replace(/'/g, "''")
}

/**
 * 用 Windows PowerShell 取回 URL:它自动走系统代理(WinINET 设置),Node 的 fetch 不走,配了代理时
 * github.com 这类站点会直连超时,这是直连失败后的兜底通道;写文件而不是读 stdout,避免编码被破坏。
 */
async function psDownload(url, dest) {
  if (process.platform !== 'win32') throw new Error('非 Windows 平台无 PowerShell 兜底通道')
  const script =
    "$ProgressPreference='SilentlyContinue';" +
    "Invoke-WebRequest -Uri '" +
    psQuote(url) +
    "' -OutFile '" +
    psQuote(dest) +
    "' -UseBasicParsing -TimeoutSec 20"
  const r = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs: 30 * 60 * 1000 },
  )
  if (r.code !== 0 || !fs.existsSync(dest)) {
    const tail = String(r.output || '')
      .split(/\r?\n/)
      .filter((x) => x.trim())
      .slice(-2)
      .join(' ')
      .slice(0, 300)
    throw new Error('系统代理通道取回失败:' + tail)
  }
  return dest
}

/** 4xx 是确定答案(比如 404 未发布),不需要再走兜底通道。 */
function isDefiniteHttpError(err) {
  return !!err && /\bHTTP 4\d\d\b/.test(String(err.message || ''))
}

async function fetchText(url, timeoutMs) {
  let directErr = null
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs || DIRECT_TIMEOUT_MS),
      headers: { 'user-agent': 'dsh-plugin-skill-updater' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (err) {
    directErr = err
  }
  if (isDefiniteHttpError(directErr) || process.platform !== 'win32') throw directErr
  const tmp = path.join(os.tmpdir(), 'dsh-uc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + '.txt')
  try {
    await psDownload(url, tmp)
    return fs.readFileSync(tmp, 'utf8')
  } finally {
    rmrf(tmp)
  }
}

async function fetchJson(url, timeoutMs) {
  return JSON.parse(await fetchText(url, timeoutMs))
}

/* 同一次检查里同一个 URL 只取一次;并发调用共享同一个 Promise,
   失败也记下来,避免失败路径被重复等待(预热与正式读取共用它)。 */
const textCache = new Map() // url -> Promise<{text}|{error}>
function cachedFetchText(url) {
  if (!textCache.has(url)) {
    textCache.set(
      url,
      fetchText(url).then(
        (text) => ({ text }),
        (err) => ({ error: String((err && err.message) || err) }),
      ),
    )
  }
  return textCache.get(url)
}

/* 并发执行 + 限流 */
async function mapLimit(items, limit, fn) {
  const list = Array.from(items)
  const results = new Array(list.length)
  if (!list.length) return results
  let cursor = 0
  const size = Math.max(1, Math.min(limit || 1, list.length))
  const workers = []
  for (let w = 0; w < size; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = cursor++
          if (i >= list.length) return
          results[i] = await fn(list[i], i)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return results
}

/* 同一个包可能被多个 profile 依赖,registry 只查一次 */
const packumentCache = new Map() // name -> { doc } | { error }
async function loadPackument(name) {
  if (packumentCache.has(name)) return packumentCache.get(name)
  let entry
  try {
    entry = { doc: await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}`) }
  } catch (err) {
    entry = { error: String((err && err.message) || err) }
  }
  packumentCache.set(name, entry)
  return entry
}

async function downloadTo(url, dest, onLine) {
  let directErr = null
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60 * 1000),
      headers: { 'user-agent': 'dsh-plugin-skill-updater' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') || 0)
    if (onLine && total) onLine(`下载中 ${(total / 1048576).toFixed(1)} MB ...`)
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
    return dest
  } catch (err) {
    directErr = err
  }
  if (isDefiniteHttpError(directErr) || process.platform !== 'win32') throw directErr
  if (onLine) onLine(`直连失败(${String((directErr && directErr.message) || directErr)}),改用系统代理通道重试 ...`)
  return await psDownload(url, dest)
}

function sha256File(file) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

function sha256Text(text) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(String(text), 'utf8'))
  return h.digest('hex')
}

function normalizeText(t) {
  return String(t == null ? '' : t).replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

function listProfiles(home) {
  const dir = path.join(home, 'profiles')
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules') continue
    const pkgPath = path.join(dir, e.name, 'package.json')
    const pkg = readJsonFile(pkgPath)
    if (!pkg || !pkg.dependencies || typeof pkg.dependencies !== 'object') continue
    out.push({ name: e.name, dir: path.join(dir, e.name), pkg })
  }
  return out
}

function installedVersion(profileDir, name) {
  const p = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  const j = readJsonFile(p)
  return j && j.version ? String(j.version) : null
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (err) {}
}

/* ===== 4. 检查 ===== */

/** 从 packument 里选出「满足声明范围 + 已过发布冷却期」的最高版本。 */
function selectCandidate(packument, range, cutoffMs) {
  const out = { installable: null, matching: null, latest: null }
  if (!packument || !packument.versions) return out
  const times = packument.time || {}
  for (const verStr of Object.keys(packument.versions)) {
    if (!satisfiesRange(verStr, range)) continue
    const sv = parseSemver(verStr)
    if (!sv) continue
    const meta = packument.versions[verStr]
    if (meta && meta.deprecated) continue
    if (!out.matching || cmpSemver(sv, out.matching) > 0) out.matching = sv
    const published = times[verStr] ? Date.parse(times[verStr]) : NaN
    if (!Number.isNaN(published) && published <= cutoffMs) {
      if (!out.installable || cmpSemver(sv, out.installable) > 0) out.installable = sv
    }
  }
  const tagLatest = packument['dist-tags'] && packument['dist-tags'].latest
  if (tagLatest) out.latest = parseSemver(tagLatest)
  return out
}

async function checkPlugins(home) {
  const cutoffMs = Date.now() - MIN_RELEASE_AGE_HOURS * 3600 * 1000
  const rows = []
  const profiles = listProfiles(home)

  // 预热:去重后并发查询所有需要查 registry 的包名(限流)。
  // 原来串行 await,慢/被墙的地址会累加(单次连接超时约 10s),
  // 极端情况下整轮检查被拖到 30s 以上,这正是「弹窗慢」的根因。
  const wanted = []
  for (const prof of profiles) {
    for (const [name, spec] of Object.entries(prof.pkg.dependencies)) {
      if (looksLikeRegistryRange(spec) && wanted.indexOf(name) < 0) wanted.push(name)
    }
  }
  await mapLimit(wanted, REGISTRY_CONCURRENCY, (n) => loadPackument(n))

  for (const prof of profiles) {
    for (const [name, spec] of Object.entries(prof.pkg.dependencies)) {
      const row = {
        id: `plugin:${prof.name}:${name}`,
        kind: 'plugin',
        scope: prof.name,
        name,
        installed: installedVersion(prof.dir, name),
        available: null,
        hasUpdate: false,
        note: '',
        skipReason: '',
      }
      if (!looksLikeRegistryRange(spec)) {
        row.skipReason = `本地/非 npm 来源(${String(spec).slice(0, 24)}),已跳过`
        rows.push(row)
        continue
      }
      const cached = packumentCache.get(name) // 预热阶段已取回,这里不再等待网络
      if (!cached) {
        row.skipReason = 'registry 查询未执行,已跳过'
        rows.push(row)
        continue
      }
      if (cached.error) {
        if (/\b404\b/.test(cached.error)) row.skipReason = 'npm 上查不到该包(未发布),已跳过'
        else row.skipReason = `registry 查询失败:${cached.error}`
        rows.push(row)
        continue
      }
      const doc = cached.doc
      const cand = selectCandidate(doc, spec, cutoffMs)
      const inst = parseSemver(row.installed)
      if (!inst) {
        row.skipReason = 'node_modules 中找不到已安装版本,已跳过'
        rows.push(row)
        continue
      }
      if (cand.installable && cmpSemver(cand.installable, inst) > 0) {
        row.hasUpdate = true
        row.available = cand.installable.raw
        if (cand.latest && cmpSemver(cand.latest, cand.installable) > 0) {
          row.note = `上游 latest 为 ${cand.latest.raw},超出声明范围 ${spec}`
        }
      } else if (cand.matching && cmpSemver(cand.matching, inst) > 0) {
        row.available = cand.matching.raw
        row.note = `新版本尚在 ${MIN_RELEASE_AGE_HOURS} 小时发布冷却期内,DSH 暂不会安装`
      } else if (cand.latest && cmpSemver(cand.latest, inst) > 0) {
        row.available = cand.latest.raw
        row.note = `latest ${cand.latest.raw} 超出声明范围 ${spec},需重新 add 才能升级`
      } else {
        row.available = cand.installable ? cand.installable.raw : row.installed
        row.note = '已是最新'
      }
      rows.push(row)
    }
  }
  return rows
}

async function checkSkills(home, skillState) {
  const root = path.join(home, 'skills')
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    return []
  }
  const rows = []

  // 预热:并发取回各 Skill 的上游数据(manifest / 版本标记 / 内容快照)。
  // 与插件同理:串行等待会让最慢的那个请求决定整体耗时。
  const warmUrls = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.system') continue
    const dir = path.join(root, e.name)
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue
    const meta = readJsonFile(path.join(dir, 'skill-release.json'))
    if (meta && meta.updateManifestUrl) { warmUrls.push(meta.updateManifestUrl); continue }
    const src = CONTENT_SKILL_SOURCES[e.name]
    if (src) { warmUrls.push(src.versionUrl, src.contentUrl) }
  }
  await mapLimit(Array.from(new Set(warmUrls)), SKILL_CONCURRENCY, (u) => cachedFetchText(u))

  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.system') continue
    const dir = path.join(root, e.name)
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue

    const row = {
      id: `skill:skills:${e.name}`,
      kind: 'skill',
      scope: 'skills',
      name: e.name,
      installed: '',
      available: null,
      hasUpdate: false,
      note: '',
      skipReason: '',
      _dir: dir,
    }

    // ---- 方式一:Skill 自带 skill-release.json + updateManifestUrl ----
    const meta = readJsonFile(path.join(dir, 'skill-release.json'))
    if (meta && meta.updateManifestUrl) {
      row.installed = String(meta.version || '未知')
      const mRes = await cachedFetchText(meta.updateManifestUrl) // 预热阶段已取回
      if (mRes.error) {
        row.skipReason = `上游 manifest 查询失败:${mRes.error}`
        rows.push(row)
        continue
      }
      let manifest = null
      try {
        manifest = JSON.parse(mRes.text)
      } catch (err) {
        row.skipReason = `上游 manifest 解析失败:${String((err && err.message) || err)}`
        rows.push(row)
        continue
      }
      const remote = parseSemver(manifest.version)
      const local = parseSemver(meta.version)
      if (remote && local && cmpSemver(remote, local) > 0) {
        row.hasUpdate = true
        row.available = remote.raw
        row.note = String(manifest.summary || '')
        row._mode = 'manifest'
        row._manifest = manifest
        row._meta = meta
      } else {
        row.available = manifest.version ? String(manifest.version) : String(meta.version || '')
        row.note = '已是最新'
      }
      rows.push(row)
      continue
    }

    // ---- 方式二:内置来源表(内容哈希 + 版本标记) ----
    const src = CONTENT_SKILL_SOURCES[e.name]
    if (!src) {
      row.skipReason = '未登记上游来源(可能是自用 Skill),已跳过'
      rows.push(row)
      continue
    }
    let remoteVer = null
    let remoteBody = null
    // 两个地址在预热阶段已并发取回,这里直接命中缓存
    const [vRes, cRes] = await Promise.all([
      cachedFetchText(src.versionUrl),
      cachedFetchText(src.contentUrl),
    ])
    if (!vRes.error) {
      try {
        const j = JSON.parse(vRes.text)
        remoteVer = j[src.versionPointer] != null ? String(j[src.versionPointer]) : null
      } catch (err) {}
    }
    if (!cRes.error) remoteBody = cRes.text
    if (vRes.error && cRes.error) {
      row.skipReason = `上游查询失败:${vRes.error}`
      rows.push(row)
      continue
    }
    let localBody = null
    const localPath = path.join(dir, src.localContent)
    try {
      localBody = fs.readFileSync(localPath, 'utf8')
    } catch (err) {}
    const contentDrift =
      !!remoteBody && !!localBody && sha256Text(normalizeText(remoteBody)) !== sha256Text(normalizeText(localBody))

    const baseline = skillState.skills[e.name] && skillState.skills[e.name].sourceVersion
    row.installed = baseline ? String(baseline) : '未记录'
    if (remoteVer) row.available = remoteVer
    row._mode = 'content'
    row._source = src

    if (!baseline) {
      if (contentDrift) {
        row.hasUpdate = true
        row.note = '本地内容与上游 main 不一致'
      } else {
        row.available = remoteVer || ''
        row.note = '已是最新'
      }
      skillState.skills[e.name] = { sourceVersion: remoteVer, checkedAt: new Date().toISOString() }
    } else {
      const b = parseSemver(baseline)
      const r = parseSemver(remoteVer)
      if (b && r && cmpSemver(r, b) > 0) {
        row.hasUpdate = true
        row.note = `上游版本 ${remoteVer}`
      } else if (contentDrift) {
        row.hasUpdate = true
        if (remoteVer) row.available = `${remoteVer} (内容变更)`
        row.note = '内容与上游 main 不一致(版本号未变)'
      } else {
        row.note = '已是最新'
      }
    }
    rows.push(row)
  }
  return rows
}

/* ===== 5. 检查状态机 ===== */

const state = {
  phase: 'idle', // idle | checking | ready | error
  error: null,
  checkedAt: null,
  items: [],
  entries: [],
  skipped: [],
}
let inflight = null

function runCheck(force) {
  if (inflight && !force) return inflight
  state.phase = 'checking'
  state.error = null
  const home = resolveDshHome()
  // 每轮检查都重新取上游数据(手动「重新检查」必须拿到最新结果)
  packumentCache.clear()
  textCache.clear()
  const skillState = readState(home)
  inflight = (async () => {
    try {
      const [plugins, skills] = await Promise.all([
        checkPlugins(home).catch((err) => {
          throw new Error('插件检查失败:' + String((err && err.message) || err))
        }),
        checkSkills(home, skillState),
      ])
      const all = [...plugins, ...skills]
      state.entries = all.map((r) => ({
        id: r.id,
        kind: r.kind,
        scope: r.scope,
        name: r.name,
        installed: r.installed || '?',
        available: r.available || null,
        status: r.skipReason ? 'skipped' : r.hasUpdate ? 'update' : 'current',
        note: r.skipReason || r.note || '',
      }))
      state.items = state.entries
        .filter((e) => e.status === 'update')
        .map((e) => Object.assign({}, e, { hasUpdate: true }))
      state.skipped = state.entries
        .filter((e) => e.status === 'skipped')
        .map((e) => ({ kind: e.kind, scope: e.scope, name: e.name, reason: e.note }))
      state.checkedAt = new Date().toISOString()
      state.phase = 'ready'
      recordLastCheck(home, skillState)
    } catch (err) {
      state.phase = 'error'
      state.error = String((err && err.message) || err)
      state.checkedAt = new Date().toISOString()
      recordLastCheck(home, skillState)
    } finally {
      inflight = null
    }
    return state
  })()
  return inflight
}

function publicStatus() {
  return {
    ok: true,
    phase: state.phase,
    error: state.error,
    checkedAt: state.checkedAt,
    minReleaseAgeHours: MIN_RELEASE_AGE_HOURS,
    host: {
      dshHome: resolveDshHome(),
      profileName: path.basename(resolveProfileDir()),
      profileDir: resolveProfileDir(),
      cli: resolveCliJs() || resolveCliShim() || null,
    },
    updateCount: state.items.length,
    items: state.items,
    entries: state.entries,
    skipped: state.skipped,
  }
}

/* ===== 6. 执行更新(后台任务) ===== */

let currentJob = null

function pushLog(job, line) {
  if (!job || !line) return
  job.log.push(String(line).slice(0, 600))
  if (job.log.length > JOB_LOG_LIMIT) job.log.splice(0, job.log.length - JOB_LOG_LIMIT)
}

function runCommand(cmd, args, opts) {
  const options = opts || {}
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: Object.assign({}, process.env, options.env || {}),
      })
    } catch (err) {
      resolve({ code: -1, output: 'spawn 失败:' + String((err && err.message) || err) })
      return
    }
    let output = ''
    let settled = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill()
          } catch (err) {}
        }, options.timeoutMs)
      : null
    const push = (chunk) => {
      const text = chunk.toString()
      output += text
      if (options.onLine) {
        for (const raw of text.split(/\r?\n/)) {
          const t = raw.replace(/\s+$/, '')
          if (t.trim()) options.onLine(t)
        }
      }
    }
    if (child.stdout) child.stdout.on('data', push)
    if (child.stderr) child.stderr.on('data', push)
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code: code === null ? -1 : code, output })
    }
    child.on('error', (err) => {
      output += String((err && err.message) || err)
      finish(-1)
    })
    child.on('close', finish)
  })
}

function startJob(items) {
  const job = {
    id: 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    running: true,
    finished: false,
    restartRequired: false,
    error: null,
    steps: items.map((it) => ({
      id: it.id,
      label: it.kind === 'plugin' ? `${it.name} (${it.scope})` : it.name,
      kind: it.kind,
      status: 'pending',
      message: '',
      from: it.installed,
      to: it.available,
    })),
    log: [],
  }
  currentJob = job
  runJob(job, items).catch((err) => {
    job.error = String((err && err.message) || err)
  }).finally(() => {
    job.running = false
    job.finished = true
    job.finishedAt = new Date().toISOString()
  })
  return job
}

function stepOf(job, id) {
  return job.steps.find((s) => s.id === id)
}

async function runJob(job, items) {
  const home = resolveDshHome()

  // ---- 插件:按 profile 分组,一次 update 多个包 ----
  const pluginItems = items.filter((it) => it.kind === 'plugin')
  const byProfile = new Map()
  for (const it of pluginItems) {
    if (!byProfile.has(it.scope)) byProfile.set(it.scope, [])
    byProfile.get(it.scope).push(it)
  }
  const cliJs = resolveCliJs()
  const shim = cliJs ? null : resolveCliShim()
  if (pluginItems.length && !cliJs && !shim) {
    for (const it of pluginItems) {
      const st = stepOf(job, it.id)
      st.status = 'failed'
      st.message = '找不到 dsh CLI,无法更新插件'
    }
  } else {
    for (const [profile, list] of byProfile) {
      const names = list.map((x) => x.name)
      for (const it of list) {
        const st = stepOf(job, it.id)
        st.status = 'running'
      }
      pushLog(job, `$ dsh plugin --profile ${profile} update ${names.join(' ')}`)
      const before = new Map(list.map((it) => [it.id, installedVersion(path.join(home, 'profiles', profile), it.name)]))
      let res
      if (cliJs) {
        res = await runCommand(
          process.execPath,
          ['--expose-internals', cliJs, 'plugin', '--profile', profile, 'update', ...names],
          {
            env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
            onLine: (l) => pushLog(job, l),
            timeoutMs: 20 * 60 * 1000,
          },
        )
      } else {
        res = await runCommand('cmd.exe', ['/d', '/c', shim, 'plugin', '--profile', profile, 'update', ...names], {
          env: { DSH_HOME: home },
          onLine: (l) => pushLog(job, l),
          timeoutMs: 20 * 60 * 1000,
        })
      }
      // 复核实际生效的版本,不只看退出码
      for (const it of list) {
        const st = stepOf(job, it.id)
        const profDir = path.join(home, 'profiles', profile)
        const after = installedVersion(profDir, it.name)
        const was = before.get(it.id)
        if (after && was && after !== was) {
          st.status = 'ok'
          st.message = `${was} → ${after}`
          job.restartRequired = true
        } else if (res.code !== 0) {
          st.status = 'failed'
          st.message = `更新失败(退出码 ${res.code})` + (after ? `,当前仍为 ${after}` : '')
        } else {
          st.status = 'skipped'
          st.message = `未发生变化,当前仍为 ${after || was || '?'}(可能受发布冷却期或声明范围限制)`
        }
      }
    }
  }

  // ---- Skill:逐个处理 ----
  for (const it of items.filter((x) => x.kind === 'skill')) {
    const st = stepOf(job, it.id)
    st.status = 'running'
    try {
      const detail = await resolveSkillDetail(it, home)
      if (!detail) throw new Error('无法解析该 Skill 的上游来源')
      if (detail.mode === 'manifest') {
        const msg = await applyManifestSkill(detail, job)
        st.status = 'ok'
        st.message = msg
      } else if (detail.mode === 'content' && detail.source.update === 'installer') {
        const msg = await applyInstallerSkill(detail, job, home)
        st.status = 'ok'
        st.message = msg
      } else {
        st.status = 'skipped'
        st.message = '该 Skill 没有可用的自动更新方式'
      }
    } catch (err) {
      st.status = 'failed'
      st.message = String((err && err.message) || err)
    }
  }

  // 更新完成后刷新检查结果
  try {
    await runCheck(true)
  } catch (err) {}
}

/** 重新解析 Skill 的上游详情(检查阶段的结果不跨请求保存,这里按需重取)。 */
async function resolveSkillDetail(item, home) {
  const dir = path.join(home, 'skills', item.name)
  const meta = readJsonFile(path.join(dir, 'skill-release.json'))
  if (meta && meta.updateManifestUrl) {
    const manifest = await fetchJson(meta.updateManifestUrl)
    return { mode: 'manifest', dir, meta, manifest }
  }
  const src = CONTENT_SKILL_SOURCES[item.name]
  if (src) return { mode: 'content', dir, source: src }
  return null
}

function findSkillRoot(dir) {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return null
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = findSkillRoot(path.join(dir, e.name))
    if (found) return found
  }
  return null
}

async function applyManifestSkill(detail, job) {
  const { dir, manifest } = detail
  const id = String(manifest.skillId || path.basename(dir))
  const repo = String((manifest.source && manifest.source.repository) || '').replace(/\/+$/, '')
  const ref = String((manifest.source && manifest.source.ref) || '')
  const wantSha = manifest.artifact && manifest.artifact.sha256 ? String(manifest.artifact.sha256).toLowerCase() : ''
  if (!repo || !ref) throw new Error('manifest 缺少 source.repository / source.ref')

  const url = `${repo}/releases/download/${ref}/${id}.zip`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-updater-'))
  try {
    const zip = path.join(tmp, `${id}.zip`)
    pushLog(job, `下载 ${url}`)
    await downloadTo(url, zip, (l) => pushLog(job, l))
    if (wantSha) {
      const got = sha256File(zip)
      if (got !== wantSha) throw new Error(`sha256 校验失败(期望 ${wantSha.slice(0, 12)}…,实际 ${got.slice(0, 12)}…)`)
      pushLog(job, 'sha256 校验通过')
    } else {
      pushLog(job, 'manifest 未提供 sha256,跳过校验')
    }
    const ex = path.join(tmp, 'x')
    fs.mkdirSync(ex, { recursive: true })
    const tar = await runCommand('tar', ['-xf', zip, '-C', ex], { onLine: (l) => pushLog(job, l), timeoutMs: 10 * 60 * 1000 })
    if (tar.code !== 0) throw new Error('解压失败(tar 退出码 ' + tar.code + ')')
    const inner = findSkillRoot(path.join(ex, id)) || findSkillRoot(ex)
    if (!inner) throw new Error('压缩包内找不到 SKILL.md')

    const backup = `${dir}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
    fs.renameSync(dir, backup)
    try {
      // 跨目录移动:同盘用 rename,失败则退回复制
      try {
        fs.renameSync(inner, dir)
      } catch (err) {
        fs.cpSync(inner, dir, { recursive: true })
      }
    } catch (err) {
      try {
        fs.renameSync(backup, dir)
      } catch (err2) {}
      throw err
    }
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('替换后缺少 SKILL.md')
    pushLog(job, `已更新,旧版本备份于 ${path.basename(backup)}`)
    return `${manifest.version} 已安装(旧版备份 ${path.basename(backup)})`
  } finally {
    rmrf(tmp)
  }
}

async function applyInstallerSkill(detail, job, home) {
  const src = detail.source
  pushLog(job, `该 Skill 需重新运行上游安装器(${src.sizeWarning})`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-updater-'))
  try {
    const zip = path.join(tmp, 'repo.zip')
    await downloadTo(src.repoArchive, zip, (l) => pushLog(job, l))
    const ex = path.join(tmp, 'x')
    fs.mkdirSync(ex, { recursive: true })
    const tar = await runCommand('tar', ['-xf', zip, '-C', ex], { onLine: (l) => pushLog(job, l), timeoutMs: 10 * 60 * 1000 })
    if (tar.code !== 0) throw new Error('解压失败(tar 退出码 ' + tar.code + ')')
    const root = path.join(ex, src.archiveInner)
    const installer = path.join(root, ...src.installer.split('/'))
    if (!fs.existsSync(installer)) throw new Error('归档内找不到安装器 ' + src.installer)

    const pythons = []
    const bundled = resolveBundledPython()
    if (bundled) pythons.push(bundled)
    const onPath = await runCommand('cmd.exe', ['/d', '/c', 'where', 'python'], { timeoutMs: 30000 })
    if (onPath.code === 0 && onPath.output.trim()) {
      const first = onPath.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      if (first && !pythons.includes(first)) pythons.push(first)
    }
    if (!pythons.length) throw new Error('找不到可用的 python')

    for (const py of pythons) {
      pushLog(job, `运行安装器:${py}`)
      const r = await runCommand(py, [installer, '--platform', src.platform, '--force'], {
        onLine: (l) => pushLog(job, l),
        timeoutMs: 30 * 60 * 1000,
      })
      if (r.code !== 0) pushLog(job, `安装器退出码 ${r.code}(${py})`)
    }
    if (!fs.existsSync(path.join(detail.dir, 'SKILL.md'))) throw new Error('更新后缺少 SKILL.md')
    return '已通过上游安装器更新'
  } finally {
    rmrf(tmp)
  }
}

/* ===== 7. 插件定义 ===== */

// 桌面壳(Electron)的 index.html 由安装包静态 dist 直出,不经过宿主 renderIndex;
// 唯一注入通道是 webserver/index-inject 的结构化行,且该表在宿主启动时一次性收集 ——
// 所以必须在 apply() 里最早注册。行内用自建 script 标签 + 吞掉 onerror,而不是
// script-src 行:后者加载失败会 reject 掉 __DSH_BOOT_READY__,应用就起不来。
const CLIENT_SRC = `${ROUTE_PREFIX}/client.js`
const INJECT_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' +
  CLIENT_SRC +
  '";s.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function readBody(req, limit) {
  const max = limit || 1024 * 1024
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > max) {
        reject(new Error('请求体过大'))
        try {
          req.destroy()
        } catch (err) {}
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  } catch (err) {}
}

export default {
  name: 'dsh-plugin-skill-updater',
  apply(root) {
    try {
      // ① 桌面端注入行:必须最早注册(启动时一次性收集)
      try {
        root.on('webserver/index-inject', (table) => {
          try {
            if (!Array.isArray(table)) return
            for (const row of table) {
              if (!row) continue
              if (row.kind === 'script-src' && row.src === CLIENT_SRC) return
              if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(CLIENT_SRC)) return
            }
            table.push({ kind: 'script', placement: 'body', text: INJECT_ROW_TEXT })
          } catch (err) {}
        })
      } catch (err) {
        console.warn('[update-center] 注册桌面端注入行失败:', String((err && err.message) || err))
      }

      // ② 其余逻辑等 webServer / connection 就绪
      root.inject(['webServer', 'connection'], (ctx) => {
        const disposers = []

        // 浏览器信任栅栏:优先委托宿主 connection.requestRejection,再叠加回环校验
        function rejection(req) {
          let code = null
          try {
            const conn = ctx.connection
            if (conn && typeof conn.requestRejection === 'function') {
              const r = conn.requestRejection(req)
              if (r) code = typeof r === 'number' ? r : 403
            }
          } catch (err) {
            code = 403 // 栅栏自己抛异常 → fail-closed
          }
          if (code) return code
          try {
            const headers = (req && req.headers) || {}
            const method = String((req && req.method) || 'GET').toUpperCase()
            const isWrite = method !== 'GET' && method !== 'HEAD'
            if (!isWrite) return null
            let host = null
            try {
              host = new URL('http://' + String(headers.host || ''))
            } catch (err) {
              return 403
            }
            if (!isLoopbackHostname(host.hostname)) return 403
            const site = String(headers['sec-fetch-site'] || '').toLowerCase()
            if (site === 'cross-site') return 403
            const origin = headers.origin
            if (origin) {
              try {
                if (new URL(origin).host !== host.host) return 403
              } catch (err) {
                return 403
              }
            }
            return null
          } catch (err) {
            return 403
          }
        }

        function register(route) {
          const inner = route.handler
          const wrapped = Object.assign({}, route, {
            handler: async (req, res) => {
              const code = rejection(req)
              if (code) {
                try {
                  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('rejected')
                } catch (err) {}
                return
              }
              try {
                return await inner(req, res)
              } catch (err) {
                sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
              }
            },
          })
          return ctx.webServer.register(wrapped)
        }

        // ---- 客户端脚本 ----
        disposers.push(
          register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/client.js`,
            handler: (req, res) => {
              let text = ''
              try {
                text = fs.readFileSync(CLIENT_JS_PATH, 'utf8') // 每次请求重读:改完刷新页面即生效
              } catch (err) {
                text = '/* update-center: assets/skill-updater.js 缺失 */'
              }
              // 落一个「客户端脚本被页面拉取过」的时间戳:不用打开界面就能判断 Web 半区是否生效
              try {
                const marker = path.join(resolveDshHome(), '.dsh-skill-updater.client')
                let prev = 0
                try {
                  prev = Date.parse(fs.readFileSync(marker, 'utf8')) || 0
                } catch (err) {}
                if (Date.now() - prev > 5000) fs.writeFileSync(marker, new Date().toISOString(), 'utf8')
              } catch (err) {}
              res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-store',
              })
              res.end(text)
            },
          }),
        )

        // ---- 插件自身版本(也用于判断宿主是否已经加载了最新代码) ----
        disposers.push(
          register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/version.json`,
            handler: (req, res) => {
              const pkg = readJsonFile(path.join(PACKAGE_ROOT, 'package.json')) || {}
              sendJson(res, 200, {
                ok: true,
                name: pkg.name || 'dsh-plugin-skill-updater',
                version: pkg.version || '0',
              })
            },
          }),
        )

        // ---- 状态:首次访问时惰性触发检查 ----
        disposers.push(
          register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/status.json`,
            handler: (req, res) => {
              if (state.phase === 'idle') runCheck(false).catch(() => {})
              sendJson(res, 200, publicStatus())
            },
          }),
        )

        // ---- 手动重新检查 ----
        disposers.push(
          register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/recheck`,
            handler: async (req, res) => {
              if (String(req.method || 'GET').toUpperCase() === 'GET') {
                sendJson(res, 405, { ok: false, error: '请使用 POST' })
                return
              }
              runCheck(true).catch(() => {})
              sendJson(res, 200, { ok: true })
            },
          }),
        )

        // ---- 执行更新 ----
        disposers.push(
          register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/apply`,
            handler: async (req, res) => {
              if (String(req.method || 'GET').toUpperCase() !== 'POST') {
                sendJson(res, 405, { ok: false, error: '请使用 POST' })
                return
              }
              if (currentJob && currentJob.running) {
                sendJson(res, 409, { ok: false, error: '已有更新任务正在执行', jobId: currentJob.id })
                return
              }
              let payload = null
              try {
                payload = JSON.parse((await readBody(req)) || '{}')
              } catch (err) {
                sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
                return
              }
              const ids = Array.isArray(payload && payload.ids) ? payload.ids : []
              const byId = new Map(state.items.map((x) => [x.id, x]))
              const chosen = ids.map((id) => byId.get(id)).filter(Boolean)
              if (!chosen.length) {
                sendJson(res, 400, { ok: false, error: '没有可更新的选中项(可能已过期,请重新检查)' })
                return
              }
              const job = startJob(chosen)
              sendJson(res, 200, { ok: true, jobId: job.id })
            },
          }),
        )

        // ---- 任务进度 ----
        disposers.push(
          register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/job.json`,
            handler: (req, res) => {
              sendJson(res, 200, { ok: true, job: currentJob })
            },
          }),
        )

        // ---- 普通浏览器形态的注入(tapIndex) ----
        try {
          disposers.push(
            ctx.webServer.tapIndex((html) => {
              if (typeof html !== 'string') return html
              if (html.includes(CLIENT_SRC)) return html
              const tag = `<script defer src="${CLIENT_SRC}"></script>`
              return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
            }),
          )
        } catch (err) {}

        ctx.effect(() => () => {
          for (const d of disposers) {
            try {
              if (typeof d === 'function') d()
            } catch (err) {}
          }
        })

        // 启动后台检查:网络请求不占启动资源,没必要等 2.5 秒
        setTimeout(() => {
          runCheck(false).catch(() => {})
        }, 300)
      })
    } catch (err) {
      // 绝不让插件加载失败影响 DSH 启动
      console.warn('[update-center] 初始化失败:', String((err && err.message) || err))
    }
  },
}

/* ================================================================== *
 * 8. 无界面自检入口(不依赖 DSH 宿主,便于排查与验证)
 *      node lib/index.js --check                 → 打印与 /status.json 相同的 JSON
 *      node lib/index.js --apply <id> [<id>...]  → 先检查,再执行指定项的更新
 * ================================================================== */

const isDirectRun = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch (err) {
    return false
  }
})()

if (isDirectRun && process.argv.includes('--check')) {
  runCheck(true)
    .then(() => {
      process.stdout.write(JSON.stringify(publicStatus(), null, 2) + '\n')
      process.exit(0)
    })
    .catch((err) => {
      process.stderr.write('check failed: ' + String((err && err.message) || err) + '\n')
      process.exit(1)
    })
}

if (isDirectRun && process.argv.includes('--apply')) {
  const idx = process.argv.indexOf('--apply')
  const wanted = process.argv.slice(idx + 1).filter((a) => a && !a.startsWith('--'))
  runCheck(true)
    .then(async () => {
      const chosen = state.items.filter((it) => wanted.includes(it.id) || wanted.includes(it.name))
      if (!chosen.length) {
        process.stdout.write('没有匹配的可更新项。当前可更新:' + JSON.stringify(state.items.map((x) => x.id)) + '\n')
        process.exit(0)
      }
      const job = startJob(chosen)
      while (!job.finished) await new Promise((r) => setTimeout(r, 500))
      process.stdout.write(JSON.stringify(job, null, 2) + '\n')
      process.exit(job.steps.some((s) => s.status === 'failed') ? 1 : 0)
    })
    .catch((err) => {
      process.stderr.write('apply failed: ' + String((err && err.message) || err) + '\n')
      process.exit(1)
    })
}
