/**
 * ark.js — 火山方舟（Ark）Seedream 生图客户端，纯 Node 标准库 + 全局 fetch。
 *
 * 端点与参数语义沿用 seedream skill 的 gen.py（已实机验证）：
 *   POST https://ark.cn-beijing.volces.com/api/v3/images/generations
 *   GET  https://ark.cn-beijing.volces.com/api/v3/models
 *
 * 能力差异（账号实测）：
 *   - Seedream 5.x：单图像素上限 4624220，不支持 4K 预设，支持 output_format(png/jpeg)、
 *     不支持 sequential_image_generation（要多张就串行连发）。
 *   - Seedream 4.x：支持 4K 与 sequential_image_generation，不接受 output_format。
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { extname, join, resolve as resolvePath } from 'node:path'

export const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
export const MODELS_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/models'
export const UA = 'dsh-imagegen/0.1'
export const TIMEOUT_MS = 300_000

export const MODEL_ALIASES = {
  '4': 'doubao-seedream-4-0-20260415',
  '4.0': 'doubao-seedream-4-0-20260415',
  '5.5': 'doubao-seedream-5-5-261028',
  '4.5': 'doubao-seedream-4-5-251128',
  '5': 'doubao-seedream-5-0-pro-260628',
  '5.0': 'doubao-seedream-5-0-pro-260628',
  '5.0-pro': 'doubao-seedream-5-0-pro-260628',
  '5.0-flash': 'doubao-seedream-5-0-flash-260915',
}

/** 已知模型的中文短名，用于 UI 展示。 */
export const MODEL_LABELS = {
  'doubao-seedream-5-5-261028': 'Seedream 5.5',
  'doubao-seedream-4-0-20260415': 'Seedream 4.0',
  'doubao-seedream-5-0-pro-260628': 'Seedream 5.0 Pro',
  'doubao-seedream-5-0-flash-260915': 'Seedream 5.0 Flash',
  'doubao-seedream-4-5-251128': 'Seedream 4.5',
}

/** 每张 2K 方图的参考价（元），仅用于 UI 粗略估算。 */
export const MODEL_PRICES = {
  'doubao-seedream-5-5-261028': 0.28,
  'doubao-seedream-4-0-20260415': 0.2,
}

export const V5_MAX_PIXELS = 4_624_220

export function resolveModel(name) {
  const n = String(name || '').trim()
  return MODEL_ALIASES[n.toLowerCase()] || n
}

export function modelLabel(id) {
  return MODEL_LABELS[id] || id
}

export function isV5(model) {
  return String(model).toLowerCase().includes('seedream-5')
}

/**
 * 5.x 不接受 4K 预设、单图 ≤ 462 万像素：就地换算，并回报一句提示。
 * @returns {{ size: string, note?: string }}
 */
export function normalizeSize(model, size) {
  const s = String(size || '2K').trim()
  if (!isV5(model)) return { size: s }
  if (/^(1K|2K)$/i.test(s)) return { size: s }
  if (/^4K$/i.test(s)) {
    return { size: '2148x2148', note: 'Seedream 5.x 单图上限 462 万像素、不支持 4K 预设，已改出 2148x2148' }
  }
  const m = /^(\d+)x(\d+)$/i.exec(s)
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (w > 0 && h > 0 && w * h > V5_MAX_PIXELS) {
      const scale = Math.sqrt(V5_MAX_PIXELS / (w * h))
      const nw = Math.max(64, Math.floor((w * scale) / 8) * 8)
      const nh = Math.max(64, Math.floor((h * scale) / 8) * 8)
      return {
        size: `${nw}x${nh}`,
        note: `尺寸超过 5.x 像素上限，已按比例缩到 ${nw}x${nh}（${(nw * nh / 1e6).toFixed(2)} MP）`,
      }
    }
  }
  return { size: s }
}

/** 参考图的真实格式 → data URL。 */
export function imageToDataUrl(bytes, filePath) {
  let mime = 'image/png'
  if (/\.jpe?g$/i.test(filePath)) mime = 'image/jpeg'
  else if (/\.webp$/i.test(filePath)) mime = 'image/webp'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

export function buildPayload(opts, model, size) {
  const payload = {
    model,
    prompt: opts.prompt,
    size,
    response_format: 'b64_json',
    watermark: Boolean(opts.watermark),
  }
  if (opts.seed !== undefined && opts.seed !== null) payload.seed = opts.seed
  if (opts.format) payload.output_format = opts.format
  if (opts.sequential && opts.n > 1) {
    payload.sequential_image_generation = 'auto'
    payload.sequential_image_generation_options = { max_images: opts.n }
  }
  if (opts.images && opts.images.length) {
    payload.image = opts.images.length === 1 ? opts.images[0] : opts.images
  }
  return payload
}

export function modelHint(errText) {
  const e = String(errText || '')
  if (e.includes('ModelNotOpen')) return '该模型没有在当前账号开通：去 console.volcengine.com/ark 开通，或改用 Seedream 4.0 / 5.5'
  if (e.includes('sequential_image_generation')) return '该模型不支持一次多张，请把 images 设为 1，或换 Seedream 4.0'
  if (e.includes('image area must be at most')) return '尺寸超出该模型像素上限，用 2K 或更小的「宽x高」'
  if (e.includes('InvalidEndpointOrModel.NotFound')) return '模型 ID 不存在或已下线，调用 imagegen_models 查在售版本'
  if (e.includes('size') && e.includes('not valid')) return '该模型不接受这个尺寸，用 1K/2K 或「宽x高」（如 1728x2304）'
  if (e.includes('AuthenticationError') || e.includes('invalid api key')) return 'API Key 无效或已失效，请在插件设置页更新'
  return undefined
}

async function postJson(url, body, key) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  return { status: res.status, text }
}

/** 按文件头判断真实格式：Seedream 常返回 JPEG，哪怕请求写的是 png。 */
export function trueExt(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'GIF8') return '.gif'
  return null
}

/**
 * 把一张结果落盘。raw 可能是 b64_json（含或不含 data: 前缀）或一个 http URL。
 * @returns {string} 最终绝对路径（扩展名按真实格式校正）
 */
export async function saveItem(item, targetPath) {
  const raw = item && (item.b64_json || item.url)
  if (!raw) throw new Error('响应里既无 b64_json 也无 url')
  let bytes
  if (/^https?:\/\//i.test(raw)) {
    const res = await fetch(raw, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`下载生成图失败 HTTP ${res.status}`)
    bytes = Buffer.from(await res.arrayBuffer())
  } else {
    const clean = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw
    bytes = Buffer.from(clean, 'base64')
  }
  let out = targetPath
  const real = trueExt(bytes)
  if (real) {
    const cur = extname(out).toLowerCase()
    const want = real === '.jpg' ? ['.jpg', '.jpeg'] : [real]
    if (!want.includes(cur)) out = out.slice(0, out.length - cur.length) + real
  }
  mkdirSync(resolvePath(out, '..'), { recursive: true })
  writeFileSync(out, bytes)
  return out
}

export function makeStamp() {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 生成图片。
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.key
 * @param {string} opts.model
 * @param {string} [opts.size]
 * @param {number} [opts.n]
 * @param {number} [opts.seed]
 * @param {string} [opts.format]  png | jpeg（仅 5.x）
 * @param {boolean} [opts.watermark]
 * @param {string[]} [opts.imageDataUrls] 参考图 data URL
 * @param {string} opts.outDir 绝对输出目录
 * @returns {Promise<object>}
 */
export async function generate(opts) {
  const model = resolveModel(opts.model)
  const { size, note } = normalizeSize(model, opts.size || '2K')
  const n = Math.max(1, Math.min(8, Number(opts.n || 1)))
  const v5 = isV5(model)
  const sequential = n > 1 && !v5
  const rounds = sequential || n <= 1 ? 1 : n
  const t0 = Date.now()
  const files = []
  let usage = null

  for (let r = 0; r < rounds; r += 1) {
    const payload = buildPayload(
      {
        prompt: opts.prompt,
        seed: opts.seed === undefined || opts.seed === null ? undefined : opts.seed + r,
        format: v5 ? opts.format : undefined,
        watermark: opts.watermark,
        sequential,
        n,
        images: opts.imageDataUrls,
      },
      model,
      size,
    )
    const { status, text } = await postJson(ENDPOINT, payload, opts.key)
    if (status !== 200) {
      let detail = text
      try {
        const doc = JSON.parse(text)
        detail = doc?.error?.message || doc?.message || text
      } catch {
        // 保留原文
      }
      return {
        ok: false,
        error: `HTTP ${status}`,
        detail: String(detail).slice(0, 1200),
        hint: modelHint(text),
        model,
        size,
        elapsedMs: Date.now() - t0,
      }
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      return { ok: false, error: '响应不是合法 JSON', detail: text.slice(0, 600), model, size }
    }
    const items = doc.data || []
    if (!items.length) {
      return { ok: false, error: '响应里没有图片数据', detail: JSON.stringify(doc).slice(0, 800), model, size }
    }
    if (doc.usage) usage = doc.usage
    for (let idx = 0; idx < items.length; idx += 1) {
      const suffix = rounds > 1 ? `-${r + 1}` : items.length > 1 ? `-${idx + 1}` : ''
      const base = `seedream-${makeStamp()}${suffix}`
      const target = join(opts.outDir, `${base}.png`)
      files.push(await saveItem(items[idx], target))
    }
  }

  return {
    ok: true,
    files,
    model,
    modelLabel: modelLabel(model),
    size,
    note,
    elapsedMs: Date.now() - t0,
    usage,
    costEstimate: MODEL_PRICES[model] ? Number((MODEL_PRICES[model] * files.length).toFixed(2)) : undefined,
  }
}

/** 平台在售 seedream 模型（需要 API Key）。 */
export async function listModels(key) {
  const res = await fetch(MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
  const doc = JSON.parse(text)
  const rows = doc.data || doc.items || []
  const live = []
  const gone = []
  for (const row of rows) {
    const id = String(row.id || '')
    if (!id.includes('seedream')) continue
    const status = String(row.status || '').trim()
    const dead = ['shutdown', 'retiring', 'deprecated', 'offline'].includes(status.toLowerCase())
    const item = { id, status, label: modelLabel(id) }
    if (dead) gone.push(item)
    else live.push(item)
  }
  return { live, gone }
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
