/**
 * dsh-imagegen — 把 Seedream（火山方舟 Ark）生图接进 DSH 的插件。
 *
 * Host 半（本文件）：
 *   - imagegen / imagegen_models / imagegen_usage 三个 agent 工具
 *   - 生图开关的全局状态 + 「生图模式」动态系统上下文
 *   - Client 半使用的同源 HTTP 路由 /dsh-imagegen/api/*
 *   - API Key / 火山 AK·SK 走 DSH credentials，绝不出现在配置里
 *
 * 组合行（bundle cordis.patch.yml）：- id: tool-imagegen / name: dsh-imagegen
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { describeKey, resolveArkKey, resolveVolcCreds, saveKey, clearKey } from './lib/keys.js'
import { generate, imageToDataUrl, listModels, modelLabel, resolveModel } from './lib/ark.js'
import { activationState, arkActivations, currentPeriod, listBills, listPackages, queryBalance } from './lib/billing.js'

export const name = 'dsh-imagegen'

export const inject = ['tools', 'sandboxPolicy']

const DEFAULT_MODEL = 'doubao-seedream-5-5-261028'
const MAX_REF_IMAGES = 6
const MAX_REF_BYTES = 10 * 1024 * 1024
const API_PREFIX = '/dsh-imagegen/api'

const volatileField = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

export const Config = Schema.object({
  defaultModel: volatileField(Schema.string().default(DEFAULT_MODEL)),
  defaultSize: Schema.string().default('2K'),
  outputDir: Schema.string().default('images'),
  watermark: Schema.boolean().default(false),
  /** 生图开关：全局共享，持久化在配置里（volatile 字段，切换不重启插件）。 */
  enabled: volatileField(Schema.boolean().default(false)),
})

/** 生图开关：跨会话共享，读写都落在配置的 volatile 字段上，重启后保持。 */
function isEnabled(config) {
  return Boolean(readField(config.enabled))
}

function readField(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

/** 把返回值净化为无损 JSON（去掉 undefined / NaN / Date 等会让工具结果校验失败的值）。 */
function plain(value) {
  if (value === undefined || value === null) return null
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) return null
      if (typeof item === 'bigint') return String(item)
      return item
    }),
  )
}

export function apply(ctx, config) {
  const tools = ctx.tools
  if (tools === undefined) return

  /** defineTool 的 JSON 净化包装。 */
  function defineJsonTool(definition) {
    const execute = definition.execute
    definition.execute = async (args, exec) => plain(await execute(args, exec))
    return defineTool(definition)
  }

  /** 当前调用所属会话的工作区根目录；取不到时退回进程 cwd。 */
  function workspaceRootOf(exec) {
    try {
      const policy = ctx.sandboxPolicy
      if (policy && typeof policy.resolve === 'function') {
        const resolved = exec && exec.agent ? policy.resolve({ session: exec.agent.session }) : policy.resolve()
        if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
          return resolved.workspaceRoot
        }
      }
    } catch {
      // 取不到就用调用方给的 cwd
    }
    return null
  }

  /** 当前配置快照（volatile 字段通过 readField 读）。 */
  function cfg() {
    return {
      defaultModel: resolveModel(readField(config.defaultModel) || DEFAULT_MODEL),
      defaultSize: readField(config.defaultSize) || '2K',
      outputDir: readField(config.outputDir) || 'images',
      watermark: Boolean(readField(config.watermark)),
    }
  }

  // ── 配置写入：只走 configEditor（profile cordis.patch.yml 由它维护） ──────
  let configWriter = null
  ctx.inject(['configEditor'], (cctx) => {
    try {
      const editor = cctx.configEditor
      if (!editor || typeof editor.edit !== 'function') return
      configWriter = async (patch) => {
        const own = ctx.fiber && ctx.fiber.entry ? ctx.fiber.entry : undefined
        const rows = typeof editor.entries === 'function' ? editor.entries() : []
        const entry = (own && rows.find((row) => row === own))
          || rows.find((row) => row && row.options && row.options.name === 'dsh-imagegen')
        if (!entry) throw new Error('找不到本插件的配置行（可能被 home patch 或命令行覆盖），请手动修改 profile 的 cordis.patch.yml 中 tool-imagegen 行')
        await editor.edit(entry, (previous) => Object.assign({}, previous, patch))
      }
    } catch (e) {
      try {
        ctx.logger.warn('[dsh-imagegen] configEditor wiring skipped: ' + String((e && e.message) || e))
      } catch {
        // logger 不可用时静默
      }
    }
  })

  async function writeConfig(patch) {
    if (!configWriter) throw new Error('当前 profile 不支持写入配置（缺少 configEditor 服务）')
    await configWriter(patch)
  }

  // ── 生图模式上下文：开关开启时每个模型步骤都能看到 ──────────────────────
  ctx.inject(['systemPrompt'], (sctx) => {
    const sp = sctx.systemPrompt
    if (!sp || typeof sp.context !== 'function') return
    sctx.effect(() =>
      sp.context({
        name: 'imagegen-mode',
        order: 10300,
        text: () => {
          if (!isEnabled(config)) return ''
          const model = cfg().defaultModel
          return [
            '图像生成模式：已开启。',
            `默认模型 ${modelLabel(model)}（${model}）。`,
            '当用户消息在描述视觉内容、要求出图 / 改图 / 上色 / 出效果图时，直接调用 imagegen 工具生成，不要只给文字方案或反问细节；',
            '除非用户没有说明画面主体，或明确要求先讨论。生成后把返回的图片路径以 markdown 图片形式给出，不要重复描述参数。',
          ].join('')
        },
      }),
    )
  })

  // ── 工具：imagegen ────────────────────────────────────────────────────
  tools.register(
    defineJsonTool({
      name: 'imagegen',
      description:
        '用火山方舟 Seedream 生成或修改图片（文生图 / 图生图 / 多图参考 / 批量出图）。返回生成图片的本地绝对路径；不要读图或转述内容，直接把路径作为 markdown 图片引用交付给用户。模型默认取插件设置，可传 model 覆盖。',
      parameters: {
        prompt: {
          type: 'string',
          description: '画面描述或改图指令。写具体的主体、风格、光线、构图；改图时写「把 X 改成 Y」这类明确指令。',
          required: true,
        },
        model: {
          type: 'string',
          description: '模型 ID 或短别名：4.0 / 5.5 / 5.0-pro。省略则用插件设置里的默认模型。5.x 支持 png/jpeg 与透明底、不支持 4K；4.0 支持 4K、不接受 format。',
        },
        size: {
          type: 'string',
          description: '输出尺寸：1K / 2K / 4K，或「宽x高」（如 1728x2304）。默认取插件设置（多为 2K）。5.x 单图像素上限 462 万，超出会自动等比缩小。',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: `参考图/待改图的本地绝对路径，最多 ${MAX_REF_IMAGES} 张。做图生图、上色、换风格、多图融合时传。`,
        },
        n: {
          type: 'number',
          description: '一次生成几张（1-8，默认 1）。5.x 会串行连发，4.x 走 sequential。',
        },
        seed: { type: 'number', description: '随机种子，用于复现同一张图。' },
        format: {
          type: 'string',
          description: '输出格式 png / jpeg，仅 Seedream 5.x 支持。要透明底请用 png 并在 prompt 里写「透明背景」。',
        },
        watermark: { type: 'boolean', description: '是否加 AI 生成水印（默认关闭）。' },
        out_dir: {
          type: 'string',
          description: '输出目录。默认是工作区下的 images/ 目录；可传绝对路径或相对工作区的路径。',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 420_000,
      execute: async (args, exec) => {
        const prompt = String(args.prompt || '').trim()
        if (!prompt) return { ok: false, error: 'prompt 不能为空' }
        const hit = await resolveArkKey(ctx)
        if (!hit) {
          return {
            ok: false,
            error: '没有可用的 ARK_API_KEY',
            hint: '在 DSH 设置 → 图像生成 里填写方舟 API Key（console.volcengine.com/ark → API Key 管理），或设置环境变量 ARK_API_KEY。',
          }
        }
        const baseDir = workspaceRootOf(exec) || (exec && (exec.cwd || exec.workingDirectory)) || process.cwd()
        const outDirRaw = String(args.out_dir || cfg().outputDir)
        const outDir = isAbsolute(outDirRaw) ? outDirRaw : resolve(baseDir, outDirRaw)

        const refPaths = Array.isArray(args.images) ? args.images.filter(Boolean).slice(0, MAX_REF_IMAGES) : []
        const imageDataUrls = []
        for (const p of refPaths) {
          const abs = isAbsolute(p) ? p : join(baseDir, p)
          try {
            const st = statSync(abs)
            if (!st.isFile()) return { ok: false, error: `参考图不是文件: ${abs}` }
            if (st.size > MAX_REF_BYTES) return { ok: false, error: `参考图超过 10MB: ${abs}` }
            imageDataUrls.push(imageToDataUrl(readFileSync(abs), abs))
          } catch (e) {
            return { ok: false, error: `参考图读取失败: ${abs}`, detail: String((e && e.message) || e) }
          }
        }

        const model = resolveModel(args.model || cfg().defaultModel)
        const result = await generate({
          prompt,
          key: hit.value,
          model,
          size: args.size || cfg().defaultSize,
          n: args.n || 1,
          seed: args.seed,
          format: args.format,
          watermark: args.watermark === undefined ? cfg().watermark : Boolean(args.watermark),
          imageDataUrls,
          outDir,
        })
        return result
      },
    }),
  )

  // ── 工具：imagegen_models ─────────────────────────────────────────────
  tools.register(
    defineJsonTool({
      name: 'imagegen_models',
      description: '列出火山方舟平台上在售的 Seedream 模型，并标注当前账号是否已开通（需要已配置 ARK_API_KEY，开通状态还需要火山 AK/SK）。用于挑选 imagegen 的 model 参数。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => {
        const hit = await resolveArkKey(ctx)
        if (!hit) return { ok: false, error: '没有可用的 ARK_API_KEY' }
        let live = []
        let gone = []
        try {
          const listed = await listModels(hit.value)
          live = listed.live
          gone = listed.gone
        } catch (e) {
          return { ok: false, error: '查询在售模型失败', detail: String((e && e.message) || e) }
        }
        const volc = await resolveVolcCreds(ctx)
        let activations
        let activationError
        if (volc) {
          const res = await arkActivations(volc.ak, volc.sk)
          activations = res.data
          activationError = res.error
        }
        return {
          ok: true,
          defaultModel: cfg().defaultModel,
          models: live.map((m) => ({
            id: m.id,
            label: m.label,
            status: m.status,
            activated: activationState(activations, m.id),
          })),
          retired: gone.map((m) => ({ id: m.id, label: m.label, status: m.status })),
          activationError,
          note: volc ? undefined : '未配置火山 AK/SK，无法标注账号开通状态（不影响出图）',
        }
      },
    }),
  )

  // ── 工具：imagegen_usage ─────────────────────────────────────────────
  tools.register(
    defineJsonTool({
      name: 'imagegen_usage',
      description: '查询火山引擎账户余额、Seedream 资源包剩余额度、本月账单与模型开通状态。需要配置火山引擎访问密钥 AK/SK（方舟 API Key 查不到余额）。',
      parameters: {
        period: { type: 'string', description: '账期，格式 YYYY-MM，默认本月。' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => {
        const volc = await resolveVolcCreds(ctx)
        if (!volc) {
          return {
            ok: false,
            error: '没有配置火山引擎 AK/SK',
            hint: '方舟 API Key 无法查询余额。去 console.volcengine.com/iam/keymanage 新建访问密钥，然后在插件设置页填入。',
          }
        }
        const period = String(args.period || currentPeriod())
        const [balance, packages, bills] = await Promise.all([
          queryBalance(volc.ak, volc.sk),
          listPackages(volc.ak, volc.sk),
          listBills(volc.ak, volc.sk, period),
        ])
        const packageRows = (packages.data || [])
          .filter((row) => JSON.stringify(row).toLowerCase().includes('seedream') || JSON.stringify(row).toLowerCase().includes('方舟'))
          .map((row) => ({
            name: row.ProductName || row.Product,
            spec: row.ConfigurationName || row.ConfigurationCode,
            remaining: row.AvailableAmount,
            total: row.TotalAmount,
            unit: row.Unit,
            expiry: row.ExpiryTime,
            status: row.Status,
          }))
        const billRows = ((bills.data && bills.data.Result) || {}).List
          || ((bills.data && bills.data.Result) || {}).BillOverviewList
          || []
        return {
          ok: true,
          period,
          balance: balance.data ? balance.data.Result || balance.data : undefined,
          balanceError: balance.error,
          packages: packageRows,
          packagesError: packages.error,
          bills: billRows.map((row) => ({
            product: row.Product || row.ProductName,
            amount: row.PayableAmount || row.PretaxAmount || row.BillingAmount,
          })),
          billsError: bills.error,
        }
      },
    }),
  )

  // ── Client 半使用的 HTTP 路由 ─────────────────────────────────────────
  ctx.inject(['webServer'], (wctx) => {
    const web = wctx.webServer
    if (!web || typeof web.register !== 'function') return

    const handle = async (req, res) => {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      const url = new URL(req.url || '/', 'http://dsh.invalid')
      const path = url.pathname.slice(API_PREFIX.length) || '/'
      const method = (req.method || 'GET').toUpperCase()

      try {
        if (path === '/state' && method === 'GET') {
          const ark = await describeKey(ctx, 'ARK_API_KEY')
          const volc = await resolveVolcCreds(ctx)
          let models = []
          let modelsError
          const hit = await resolveArkKey(ctx)
          if (hit) {
            try {
              const listed = await listModels(hit.value)
              let activations
              if (volc) {
                const act = await arkActivations(volc.ak, volc.sk)
                activations = act.data
              }
              models = listed.live.map((m) => ({
                id: m.id,
                label: m.label,
                activated: activationState(activations, m.id),
              }))
            } catch (e) {
              modelsError = String((e && e.message) || e)
            }
          }
          sendJson(res, 200, {
            ok: true,
            enabled: isEnabled(config),
            model: cfg().defaultModel,
            defaultSize: cfg().defaultSize,
            outputDir: cfg().outputDir,
            models,
            modelsError,
            key: ark,
            volcConfigured: Boolean(volc),
          })
          return
        }

        if (path === '/state' && method === 'POST') {
          const body = await readJsonBody(req)
          if (typeof body.enabled === 'boolean' && body.enabled !== isEnabled(config)) {
            await writeConfig({ enabled: body.enabled })
          }
          if (typeof body.model === 'string' && body.model.trim()) {
            const next = resolveModel(body.model.trim())
            if (next !== cfg().defaultModel) await writeConfig({ defaultModel: next })
          }
          if (typeof body.defaultSize === 'string' && body.defaultSize.trim()) {
            await writeConfig({ defaultSize: body.defaultSize.trim() })
          }
          if (typeof body.outputDir === 'string' && body.outputDir.trim()) {
            await writeConfig({ outputDir: body.outputDir.trim() })
          }
          sendJson(res, 200, { ok: true, enabled: isEnabled(config), model: cfg().defaultModel })
          return
        }

        if (path === '/keys' && method === 'POST') {
          const body = await readJsonBody(req)
          const saved = []
          if (typeof body.ark === 'string' && body.ark.trim()) {
            await saveKey(ctx, 'ARK_API_KEY', body.ark)
            saved.push('ARK_API_KEY')
          }
          if (typeof body.ak === 'string' && body.ak.trim()) {
            await saveKey(ctx, 'VOLC_ACCESSKEY', body.ak)
            saved.push('VOLC_ACCESSKEY')
          }
          if (typeof body.sk === 'string' && body.sk.trim()) {
            await saveKey(ctx, 'VOLC_SECRETKEY', body.sk)
            saved.push('VOLC_SECRETKEY')
          }
          sendJson(res, 200, { ok: true, saved })
          return
        }

        if (path === '/keys' && method === 'DELETE') {
          const name = url.searchParams.get('name') || ''
          const allowed = ['ARK_API_KEY', 'VOLC_ACCESSKEY', 'VOLC_SECRETKEY']
          if (!allowed.includes(name)) {
            sendJson(res, 400, { ok: false, error: 'unsupported credential name' })
            return
          }
          await clearKey(ctx, name)
          sendJson(res, 200, { ok: true })
          return
        }

        if (path === '/usage' && method === 'GET') {
          const volc = await resolveVolcCreds(ctx)
          if (!volc) {
            sendJson(res, 200, { ok: false, error: '未配置火山 AK/SK，无法查询余额与账单' })
            return
          }
          const period = url.searchParams.get('period') || currentPeriod()
          const [balance, packages, bills] = await Promise.all([
            queryBalance(volc.ak, volc.sk),
            listPackages(volc.ak, volc.sk),
            listBills(volc.ak, volc.sk, period),
          ])
          const packageRows = (packages.data || [])
            .filter((row) => {
              const text = JSON.stringify(row).toLowerCase()
              return text.includes('seedream') || text.includes('方舟') || text.includes('ark')
            })
            .map((row) => ({
              name: row.ProductName || row.Product,
              spec: row.ConfigurationName || row.ConfigurationCode,
              remaining: row.AvailableAmount,
              total: row.TotalAmount,
              unit: row.Unit,
              expiry: row.ExpiryTime,
              status: row.Status,
            }))
          const billRows = ((bills.data && bills.data.Result) || {}).List
            || ((bills.data && bills.data.Result) || {}).BillOverviewList
            || []
          sendJson(res, 200, {
            ok: true,
            period,
            balance: balance.data ? balance.data.Result || balance.data : undefined,
            balanceError: balance.error,
            packages: packageRows,
            packagesError: packages.error,
            bills: billRows.map((row) => ({
              product: row.Product || row.ProductName,
              amount: row.PayableAmount || row.PretaxAmount || row.BillingAmount,
            })),
            billsError: bills.error,
          })
          return
        }

        if (path === '/test' && method === 'POST') {
          const hit = await resolveArkKey(ctx)
          if (!hit) {
            sendJson(res, 200, { ok: false, error: '未配置 ARK_API_KEY' })
            return
          }
          try {
            const listed = await listModels(hit.value)
            sendJson(res, 200, { ok: true, models: listed.live.length, source: hit.source, sample: listed.live.slice(0, 3).map((m) => m.id) })
          } catch (e) {
            sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
          }
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }

    try {
      wctx.effect(() => web.register({ kind: 'prefix', path: API_PREFIX, handler: handle }))
    } catch (e) {
      try {
        ctx.logger.warn('[dsh-imagegen] webServer route skipped: ' + String((e && e.message) || e))
      } catch {
        // ignore
      }
    }
  })
}
