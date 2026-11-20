/**
 * billing.js — 火山引擎费用中心 / 方舟管控面查询（Node 版 SignerV4）。
 *
 * 与 seedream skill 的 billing.py 逐字节对齐（SignerV4 已用官方 SDK 对拍过）：
 *   - 费用中心：host billing.volcengineapi.com，service=billing，region=cn-north-1，Version=2022-01-01
 *   - 方舟管控：host ark.cn-beijing.volcengineapi.com，service=ark，region=cn-beijing，Version=2024-01-01
 *
 * 注意：这里用的是「火山引擎访问密钥 AK/SK」，不是方舟 ARK_API_KEY。
 */

import { createHash, createHmac } from 'node:crypto'

export const BILLING = {
  host: 'billing.volcengineapi.com',
  service: 'billing',
  region: 'cn-north-1',
  version: '2022-01-01',
}

export const ARK_CONTROL = {
  host: 'ark.cn-beijing.volcengineapi.com',
  service: 'ark',
  region: 'cn-beijing',
  version: '2024-01-01',
}

const UA = 'dsh-imagegen/0.1 (billing)'

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** query 规范排序 + RFC3986 编码。 */
export function normQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}=${encodeURIComponent(String(params[k])).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    .join('&')
}

export function xDateNow(d = new Date()) {
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/**
 * 火山 SignerV4。
 * @returns {{ authorization: string, xdate: string, bodyHash: string }}
 */
export function signV4({ ak, sk, method, host, path = '/', query = {}, body = '', service, region, xdate }) {
  const svc = service || BILLING.service
  const rgn = region || BILLING.region
  const date = (xdate || xDateNow()).slice(0, 8)
  const stamp = xdate || xDateNow()
  const bodyHash = sha256Hex(body)
  const headers = {
    host,
    'content-type': 'application/json',
    'x-date': stamp,
    'x-content-sha256': bodyHash,
  }
  const signedNames = Object.keys(headers).sort()
  const signedStr = signedNames.map((k) => `${k}:${headers[k]}\n`).join('')
  const canonical = [
    method,
    path,
    normQuery(query),
    signedStr,
    signedNames.join(';'),
    bodyHash,
  ].join('\n')
  const scope = `${date}/${rgn}/${svc}/request`
  const sts = ['HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n')
  const k = hmac(hmac(hmac(hmac(sk, date), rgn), svc), 'request')
  const sig = createHmac('sha256', k).update(sts, 'utf8').digest('hex')
  return {
    authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${sig}`,
    xdate: stamp,
    bodyHash,
  }
}

/**
 * 调任意火山 OpenAPI。
 * @returns {{ data?: object, error?: string }}
 */
export async function callApi({ ak, sk, action, body = {}, version, host, service, region }) {
  const target = host
    ? { host, service: service || BILLING.service, region: region || BILLING.region, version: version || BILLING.version }
    : BILLING
  const query = { Action: action, Version: target.version }
  const text = JSON.stringify(body)
  const signed = signV4({ ak, sk, method: 'POST', host: target.host, path: '/', query, body: text, service: target.service, region: target.region })
  const url = `https://${target.host}/?${normQuery(query)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Date': signed.xdate,
        'X-Content-Sha256': signed.bodyHash,
        Authorization: signed.authorization,
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: text,
      signal: AbortSignal.timeout(30_000),
    })
    const raw = await res.text()
    if (!res.ok) return { error: `HTTP ${res.status}: ${raw.slice(0, 400)}` }
    try {
      return { data: JSON.parse(raw) }
    } catch {
      return { error: `响应不是 JSON: ${raw.slice(0, 300)}` }
    }
  } catch (e) {
    return { error: `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}` }
  }
}

export async function queryBalance(ak, sk) {
  return callApi({ ak, sk, action: 'QueryBalanceAcct', body: {} })
}

export async function listPackages(ak, sk) {
  const rows = []
  const seen = new Set()
  let token
  for (let i = 0; i < 20; i += 1) {
    const body = { ResourceType: 'Package', MaxResults: '10' }
    if (token) body.NextToken = token
    const { data, error } = await callApi({ ak, sk, action: 'ListResourcePackages', body })
    if (error) return { data: rows, error }
    const result = (data && data.Result) || {}
    let fresh = 0
    for (const row of result.List || []) {
      const key = row.InstanceNo || JSON.stringify(row)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
      fresh += 1
    }
    token = result.NextToken
    if (!token || fresh === 0) break
  }
  return { data: rows }
}

export async function listBills(ak, sk, period) {
  const body = { Limit: 300 }
  if (period) body.BillPeriod = period
  return callApi({ ak, sk, action: 'ListBillOverviewByProd', body })
}

/** 方舟管控面：账号开通的模型 { 基础模型名: State }。 */
export async function arkActivations(ak, sk) {
  const { data, error } = await callApi({
    ak,
    sk,
    action: 'ListModelActivations',
    body: { PageNumber: 1, PageSize: 100 },
    host: ARK_CONTROL.host,
    service: ARK_CONTROL.service,
    region: ARK_CONTROL.region,
    version: ARK_CONTROL.version,
  })
  if (error) return { error }
  const out = {}
  for (const item of ((data && data.Result) || {}).Items || []) {
    const name = item.FoundationModelName
    if (name) out[name] = item.State || '?'
  }
  return { data: out }
}

/** 把基础模型名（不带日期）与具体模型 ID 对齐，用于"是否已开通"标注。 */
export function activationState(activations, modelId) {
  if (!activations) return undefined
  const base = String(modelId).replace(/-\d{6,8}$/, '')
  return activations[base]
}

export function currentPeriod(d = new Date()) {
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
}
