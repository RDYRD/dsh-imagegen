/**
 * keys.js — API Key 与火山 AK/SK 的解析与保存。
 *
 * 解析优先级（对齐 seedream skill 的 gen.py，并优先用 DSH 凭据存储）：
 *   1. DSH credentials（ctx.credentials.resolve('ARK_API_KEY')，含其环境回退）
 *   2. 进程环境变量 ARK_API_KEY / ARK_KEY / SEEDREAM_API_KEY
 *   3. ~/.dsh/secrets/imagegen.env
 *   4. ~/.dsh/skills/seedream/.secrets.env   ← 旧 skill 目录，迁移期只读
 *
 * 值永不回显、永不写入插件配置；写入一律走 ctx.credentials.set()。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEY_NAMES = ['ARK_API_KEY', 'ARK_KEY', 'SEEDREAM_API_KEY']
const AK_NAMES = ['VOLC_ACCESSKEY', 'VOLC_ACCESS_KEY_ID', 'VOLC_AK']
const SK_NAMES = ['VOLC_SECRETKEY', 'VOLC_SECRET_ACCESS_KEY', 'VOLC_SK']

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

export function envFilePaths() {
  const home = homeDir()
  return [
    join(home, '.dsh', 'secrets', 'imagegen.env'),
    join(home, '.dsh', 'skills', 'seedream', '.secrets.env'),
  ]
}

function parseEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const name = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[name] = value
  }
  return out
}

/** 从旧的 env 文件里找第一命中（只读迁移来源）。 */
function lookupEnvFiles(names) {
  for (const path of envFilePaths()) {
    const env = parseEnvFile(path)
    for (const name of names) {
      const value = env[name]
      if (value) return { value, source: `file:${path}` }
    }
  }
  return undefined
}

async function credentialResolve(ctx, ref) {
  const creds = ctx.get('credentials')
  if (!creds || typeof creds.resolve !== 'function') return undefined
  try {
    const hit = await creds.resolve(ref)
    if (hit && typeof hit.value === 'string' && hit.value.trim()) {
      return { value: hit.value.trim(), source: hit.source || 'credential' }
    }
  } catch {
    // 服务存在但解析失败：继续按文件兜底
  }
  return undefined
}

/**
 * 解析 Ark API Key。
 * @returns {Promise<{ value: string, source: string } | undefined>}
 */
export async function resolveArkKey(ctx) {
  const hit = await credentialResolve(ctx, 'ARK_API_KEY')
  if (hit) return hit
  for (const name of KEY_NAMES) {
    const value = process.env[name]
    if (value && value.trim()) return { value: value.trim(), source: `env:${name}` }
  }
  return lookupEnvFiles(KEY_NAMES)
}

/** 火山 IAM AK/SK（用量查询才需要）。 */
export async function resolveVolcCreds(ctx) {
  const akHit = await credentialResolve(ctx, 'VOLC_ACCESSKEY')
  const skHit = await credentialResolve(ctx, 'VOLC_SECRETKEY')
  if (akHit && skHit) return { ak: akHit.value, sk: skHit.value, source: 'credential' }
  let ak = ''
  let sk = ''
  for (const name of AK_NAMES) {
    if (process.env[name]) {
      ak = process.env[name].trim()
      break
    }
  }
  for (const name of SK_NAMES) {
    if (process.env[name]) {
      sk = process.env[name].trim()
      break
    }
  }
  if (ak && sk) return { ak, sk, source: 'env' }
  const files = lookupEnvFiles([...AK_NAMES, ...SK_NAMES])
  if (files) {
    for (const path of envFilePaths()) {
      const env = parseEnvFile(path)
      const a = AK_NAMES.map((n) => env[n]).find(Boolean)
      const s = SK_NAMES.map((n) => env[n]).find(Boolean)
      if (a && s) return { ak: a, sk: s, source: `file:${path}` }
    }
  }
  return undefined
}

/** 只报告"是否已配置 + 来源"，绝不返回值。 */
export async function describeKey(ctx, ref) {
  const creds = ctx.get('credentials')
  if (creds && typeof creds.describe === 'function') {
    try {
      const info = await creds.describe(ref)
      if (info && info.configured) return { configured: true, source: info.source, masked: info.masked, writable: info.writable }
    } catch {
      // 忽略，继续给出静态判断
    }
  }
  const hit = await resolveArkKey(ctx)
  return { configured: Boolean(hit), source: hit ? hit.source : undefined, writable: true }
}

export async function saveKey(ctx, ref, value) {
  const creds = ctx.get('credentials')
  if (!creds || typeof creds.set !== 'function') {
    throw new Error('当前 profile 没有 credentials 服务，无法保存密钥')
  }
  const trimmed = String(value || '').trim()
  if (!trimmed) throw new Error('密钥不能为空')
  await creds.set(ref, trimmed)
  return { ok: true }
}

export async function clearKey(ctx, ref) {
  const creds = ctx.get('credentials')
  if (!creds || typeof creds.unset !== 'function') {
    throw new Error('当前 profile 没有 credentials 服务，无法清除密钥')
  }
  await creds.unset(ref)
  return { ok: true }
}
