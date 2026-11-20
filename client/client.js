/**
 * dsh-imagegen — Client 半
 *
 *  - settings.section「图像生成」：开关、默认模型、密钥、用量看板、测试连接
 *  - conversation.input.left 工具行控件：🖼 生图 开 · seedream 5.5 ▾（与权限 / 模型选择同排）
 *
 * 与 Host 半通过同源 HTTP 路由 /dsh-imagegen/api/* 通信。
 */

window.__ModuleLoader__.load({
  id: 'dsh-imagegen',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/dsh-imagegen/api'

    async function api(path, init) {
      const res = await fetch(API + path, Object.assign({ headers: { 'content-type': 'application/json' } }, init))
      let data = null
      try {
        data = await res.json()
      } catch (e) {
        data = { ok: false, error: 'invalid response' }
      }
      return data
    }

    // ── 全局共享状态：Dock 与设置页共用一份 ────────────────────────────────
    const store = {
      state: null,
      listeners: new Set(),
      set(next) {
        store.state = Object.assign({}, store.state, next)
        for (const fn of store.listeners) fn(store.state)
      },
      subscribe(fn) {
        store.listeners.add(fn)
        return () => store.listeners.delete(fn)
      },
    }

    async function refresh() {
      try {
        const data = await api('/state')
        if (data && data.ok) store.set(data)
        else store.set({ error: (data && data.error) || '无法读取插件状态' })
      } catch (e) {
        store.set({ error: String((e && e.message) || e) })
      }
    }

    let loaded = false
    function ensureLoaded() {
      if (loaded) return
      loaded = true
      refresh()
    }

    function useStore() {
      const [snapshot, setSnapshot] = useState(store.state)
      useEffect(() => {
        ensureLoaded()
        const off = store.subscribe(setSnapshot)
        if (store.state) setSnapshot(store.state)
        return off
      }, [])
      return snapshot || { loading: true }
    }

    // ── 通用小部件 ────────────────────────────────────────────────────────
    function Toggle(props) {
      const on = Boolean(props.value)
      const disabled = Boolean(props.disabled)
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-imagegen-toggle' + (on ? ' is-on' : ''),
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          disabled: disabled,
          onClick: () => !disabled && props.onChange(!on),
          title: props.title,
        },
        h('span', { className: 'dsh-imagegen-toggle-knob' }),
      )
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dsh-imagegen-field' },
        h('span', { className: 'dsh-imagegen-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'dsh-imagegen-hint' }, props.hint) : null,
      )
    }

    // 自绘下拉：原生 <option> 弹层在深色主题下会变成白底浅灰字，看不清。
    function Picker(props) {
      const [open, setOpen] = useState(false)
      const ref = useRef(null)

      useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      const items = props.items || []
      const current = items.find((item) => item.value === props.value)
      const label = current ? current.label : props.value || '未选择'

      return h('div', { className: 'dsh-imagegen-picker', ref },
        h('button', {
          type: 'button',
          className: 'dsh-imagegen-picker-btn',
          disabled: Boolean(props.disabled),
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'dsh-imagegen-picker-value' }, label),
          h('span', { className: 'dsh-imagegen-caret' }, '▾'),
        ),
        open
          ? h('div', { className: 'dsh-imagegen-menu is-down' },
              items.map((item) =>
                h('button', {
                  key: item.value,
                  type: 'button',
                  className: 'dsh-imagegen-menu-item' + (item.value === props.value ? ' is-active' : ''),
                  onClick: () => {
                    setOpen(false)
                    if (item.value !== props.value) props.onChange(item.value)
                  },
                },
                  h('span', null, item.label),
                  item.badge
                    ? h('span', { className: 'dsh-imagegen-badge' + (item.badgeMuted ? ' is-muted' : '') }, item.badge)
                    : null,
                ),
              ),
            )
          : null,
      )
    }

    function Callout(props) {
      return h('div', { className: 'dsh-imagegen-callout' + (props.error ? ' is-error' : '') }, props.children)
    }

    const MODEL_SHORT = {
      'doubao-seedream-5-5-261028': 'seedream 5.5',
      'doubao-seedream-4-0-20260415': 'seedream 4.0',
    }
    function shortModel(id) {
      return MODEL_SHORT[id] || String(id || '').replace('doubao-', '')
    }

    // ── 设置页 ────────────────────────────────────────────────────────────
    function SettingsPage() {
      const state = useStore()
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [arkInput, setArkInput] = useState('')
      const [akInput, setAkInput] = useState('')
      const [skInput, setSkInput] = useState('')
      const [showVolc, setShowVolc] = useState(false)
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [usage, setUsage] = useState(null)
      const [usageLoading, setUsageLoading] = useState(false)

      const patch = useCallback(async (body, label) => {
        setBusy(label)
        setNotice(null)
        const data = await api('/state', { method: 'POST', body: JSON.stringify(body) })
        setBusy('')
        if (data && data.ok) {
          store.set(data)
          setNotice({ ok: true, text: '已保存' })
        } else {
          setNotice({ ok: false, text: (data && data.error) || '保存失败' })
        }
      }, [])

      const saveKeys = useCallback(async () => {
        const body = {}
        if (arkInput.trim()) body.ark = arkInput.trim()
        if (akInput.trim()) body.ak = akInput.trim()
        if (skInput.trim()) body.sk = skInput.trim()
        if (!Object.keys(body).length) {
          setNotice({ ok: false, text: '请输入要保存的密钥' })
          return
        }
        setBusy('keys')
        setNotice(null)
        const data = await api('/keys', { method: 'POST', body: JSON.stringify(body) })
        setBusy('')
        if (data && data.ok) {
          setArkInput('')
          setAkInput('')
          setSkInput('')
          setNotice({ ok: true, text: '密钥已保存到 DSH 凭据库' })
          refresh()
        } else {
          setNotice({ ok: false, text: (data && data.error) || '保存失败' })
        }
      }, [arkInput, akInput, skInput])

      const clearKey = useCallback(async (name) => {
        setBusy(name)
        setNotice(null)
        const data = await api('/keys?name=' + encodeURIComponent(name), { method: 'DELETE' })
        setBusy('')
        if (data && data.ok) {
          setNotice({ ok: true, text: '已清除 ' + name })
          refresh()
        } else {
          setNotice({ ok: false, text: (data && data.error) || '清除失败' })
        }
      }, [])

      const loadUsage = useCallback(async () => {
        setUsageLoading(true)
        const data = await api('/usage')
        setUsageLoading(false)
        setUsage(data)
      }, [])

      const test = useCallback(async () => {
        setBusy('test')
        setNotice(null)
        const data = await api('/test', { method: 'POST', body: '{}' })
        setBusy('')
        setNotice(
          data && data.ok
            ? { ok: true, text: '连接正常，可见 ' + data.models + ' 个在售模型' }
            : { ok: false, text: (data && data.error) || '连接失败' },
        )
      }, [])

      const models = state.models || []
      const key = state.key || { configured: false }

      return h(
        'div',
        { className: 'dsh-imagegen-settings' },
        h('header', { className: 'dsh-imagegen-header' },
          h('h2', null, '图像生成'),
          h('p', null, '把 Seedream（火山方舟）接进对话：开启后模型可直接出图，结果以图片路径交付。'),
        ),

        notice
          ? h(Callout, { error: !notice.ok }, notice.text)
          : null,

        // 开关 + 默认模型
        h('section', { className: 'dsh-imagegen-card' },
          h('div', { className: 'dsh-imagegen-row' },
            h('div', null,
              h('div', { className: 'dsh-imagegen-title' }, '生图模式'),
              h('div', { className: 'dsh-imagegen-desc' },
                state.enabled ? '已开启：模型看到「图像生成模式」，可自主出图。' : '已关闭：模型不会主动出图。'),
            ),
            h(Toggle, {
              value: Boolean(state.enabled),
              disabled: busy === 'toggle',
              onChange: (next) => patch({ enabled: next }, 'toggle'),
            }),
          ),
          h('div', { className: 'dsh-imagegen-row' },
            h('div', null,
              h('div', { className: 'dsh-imagegen-title' }, '默认模型'),
              h('div', { className: 'dsh-imagegen-desc' }, '出图默认用这个模型；输入框下方的胶囊里可以临时换。'),
            ),
            h(Picker, {
              value: state.model || '',
              disabled: busy === 'model',
              items: (models.length ? models : [{ id: state.model }]).map((m) => ({
                value: m.id,
                label: shortModel(m.id),
                badge: m.activated === 'Available' ? '已开通' : m.activated === 'Unavailable' ? '未开通' : null,
                badgeMuted: m.activated !== 'Available',
              })),
              onChange: (next) => patch({ model: next }, 'model'),
            }),
          ),
        ),

        // 密钥
        h('section', { className: 'dsh-imagegen-card' },
          h('div', { className: 'dsh-imagegen-section-title' }, '方舟 API Key'),
          h('div', { className: 'dsh-imagegen-desc' },
            key.configured
              ? '当前：' + (key.masked || '已配置') + '（来源：' + (key.source || '未知') + '）'
              : '尚未配置。到 console.volcengine.com/ark → API Key 管理 获取。',
          ),
          h('div', { className: 'dsh-imagegen-inline' },
            h('input', {
              className: 'dsh-imagegen-input',
              type: 'password',
              placeholder: key.configured ? '输入新的 Key 以覆盖' : 'ARK_API_KEY',
              value: arkInput,
              onChange: (e) => setArkInput(e.target.value),
            }),
            h('button', { type: 'button', className: 'dsh-imagegen-btn is-primary', disabled: busy === 'keys', onClick: saveKeys }, '保存'),
            key.configured
              ? h('button', { type: 'button', className: 'dsh-imagegen-btn', disabled: busy === 'ARK_API_KEY', onClick: () => clearKey('ARK_API_KEY') }, '清除')
              : null,
          ),
          h('button', {
            type: 'button',
            className: 'dsh-imagegen-link',
            onClick: () => setShowVolc(!showVolc),
          }, (showVolc ? '▾ ' : '▸ ') + '用量查询需要火山 AK/SK（方舟 Key 查不到余额）'),

          showVolc
            ? h('div', { className: 'dsh-imagegen-nested' },
                h(Field, { label: 'AccessKey ID', hint: 'IAM → 访问密钥，用来读余额与账单' },
                  h('input', {
                    className: 'dsh-imagegen-input',
                    type: 'password',
                    placeholder: state.volcConfigured ? '已配置，输入以覆盖' : 'VOLC_ACCESSKEY',
                    value: akInput,
                    onChange: (e) => setAkInput(e.target.value),
                  }),
                ),
                h(Field, { label: 'SecretAccessKey' },
                  h('input', {
                    className: 'dsh-imagegen-input',
                    type: 'password',
                    placeholder: state.volcConfigured ? '已配置，输入以覆盖' : 'VOLC_SECRETKEY',
                    value: skInput,
                    onChange: (e) => setSkInput(e.target.value),
                  }),
                ),
                h('div', { className: 'dsh-imagegen-inline' },
                  h('button', { type: 'button', className: 'dsh-imagegen-btn is-primary', disabled: busy === 'keys', onClick: saveKeys }, '保存 AK/SK'),
                  state.volcConfigured
                    ? h('button', { type: 'button', className: 'dsh-imagegen-btn', onClick: () => clearKey('VOLC_ACCESSKEY') }, '清除 AK')
                    : null,
                ),
              )
            : null,
        ),

        // 用量
        h('section', { className: 'dsh-imagegen-card' },
          h('div', { className: 'dsh-imagegen-section-title' }, '用量与账单'),
          h('div', { className: 'dsh-imagegen-desc' }, '余额、Seedream 资源包余量、本月账单。'),
          h('div', { className: 'dsh-imagegen-inline' },
            h('button', { type: 'button', className: 'dsh-imagegen-btn', disabled: usageLoading, onClick: loadUsage }, usageLoading ? '查询中…' : '查询用量'),
            h('button', { type: 'button', className: 'dsh-imagegen-btn', disabled: busy === 'test', onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
          ),
          usage
            ? h('div', { className: 'dsh-imagegen-usage' }, renderUsage(usage))
            : null,
        ),

        // 高级
        h('section', { className: 'dsh-imagegen-card' },
          h('button', {
            type: 'button',
            className: 'dsh-imagegen-link',
            onClick: () => setShowAdvanced(!showAdvanced),
          }, (showAdvanced ? '▾ ' : '▸ ') + '高级'),
          showAdvanced
            ? h('div', { className: 'dsh-imagegen-nested' },
                h(Field, { label: '默认尺寸', hint: '1K / 2K / 4K，或宽x高' },
                  h('input', {
                    className: 'dsh-imagegen-input',
                    defaultValue: state.defaultSize || '2K',
                    onBlur: (e) => patch({ defaultSize: e.target.value.trim() || '2K' }, 'size'),
                  }),
                ),
                h(Field, { label: '输出目录', hint: '相对工作区的目录名，默认 images' },
                  h('input', {
                    className: 'dsh-imagegen-input',
                    defaultValue: state.outputDir || 'images',
                    onBlur: (e) => patch({ outputDir: e.target.value.trim() || 'images' }, 'dir'),
                  }),
                ),
              )
            : null,
        ),
      )
    }

    function renderUsage(usage) {
      if (!usage || usage.ok === false) {
        return h(Callout, { error: true }, (usage && usage.error) || '未获取到用量数据')
      }
      const balance = usage.balance || {}
      const packs = usage.packages || []
      const bills = usage.bills || []
      return h('div', null,
        h('div', { className: 'dsh-imagegen-kv' },
          h('span', null, '可用余额'),
          h('strong', null, balance.AvailableBalance !== undefined ? String(balance.AvailableBalance) + ' ' + (balance.Currency || 'CNY') : '—'),
        ),
        packs.length
          ? h('div', { className: 'dsh-imagegen-subtitle' }, '资源包')
          : null,
        packs.map((p, i) => h('div', { key: 'p' + i, className: 'dsh-imagegen-kv' },
          h('span', null, (p.name || p.spec || '资源包') + (p.spec && p.name ? ' · ' + p.spec : '')),
          h('strong', null, String(p.remaining !== undefined ? p.remaining : '?') + (p.unit ? ' ' + p.unit : '') + (p.expiry ? ' · ' + String(p.expiry).slice(0, 10) : '')),
        )),
        bills.length
          ? h('div', { className: 'dsh-imagegen-subtitle' }, '本月账单（' + usage.period + '）')
          : null,
        bills.slice(0, 6).map((b, i) => h('div', { key: 'b' + i, className: 'dsh-imagegen-kv' },
          h('span', null, b.product || '费用'),
          h('strong', null, String(b.amount === undefined ? '—' : b.amount)),
        )),
      )
    }

    // ── 输入框工具行：生图开关（与权限选择、模型选择同排） ─────────────────
    function ImagegenControl() {
      const state = useStore()
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [menuPos, setMenuPos] = useState(null)
      const rootRef = useRef(null)
      const modelBtnRef = useRef(null)

      useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const enabled = Boolean(state.enabled)
      const models = state.models || []

      const openMenu = () => {
        if (open) {
          setOpen(false)
          return
        }
        const el = modelBtnRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const width = 210
          const left = Math.max(8, Math.min(rect.left, (window.innerWidth || 1024) - width - 8))
          setMenuPos({ left, bottom: Math.max(8, (window.innerHeight || 768) - rect.top + 6) })
        }
        setOpen(true)
      }

      const toggle = useCallback(async () => {
        setBusy(true)
        const data = await api('/state', { method: 'POST', body: JSON.stringify({ enabled: !enabled }) })
        setBusy(false)
        if (data && data.ok) store.set(data)
      }, [enabled])

      const pick = useCallback(async (id) => {
        setOpen(false)
        setBusy(true)
        const data = await api('/state', { method: 'POST', body: JSON.stringify({ model: id }) })
        setBusy(false)
        if (data && data.ok) store.set(data)
      }, [])

      return h('div', { className: 'dsh-imagegen-toolrow', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'dsh-imagegen-trigger' + (enabled ? ' is-on' : ''),
          disabled: busy,
          onClick: toggle,
          title: enabled ? '生图模式已开启，点击关闭' : '生图模式已关闭，点击开启',
        },
          h('span', { className: 'dsh-imagegen-trigger-icon' }, '🖼'),
          h('span', null, '生图'),
          h('span', { className: 'dsh-imagegen-trigger-state' }, enabled ? '开' : '关'),
        ),
        enabled
          ? h('button', {
              type: 'button',
              ref: modelBtnRef,
              className: 'dsh-imagegen-trigger is-model',
              onClick: openMenu,
              title: '选择生图模型',
            },
              h('span', { className: 'dsh-imagegen-trigger-model' }, shortModel(state.model)),
              h('span', { className: 'dsh-imagegen-caret' }, '▾'),
            )
          : null,
        open
          ? h('div', {
              className: 'dsh-imagegen-menu is-fixed',
              style: menuPos ? { left: menuPos.left + 'px', bottom: menuPos.bottom + 'px' } : undefined,
            },
              (models.length ? models : [{ id: state.model }]).map((m) =>
                h('button', {
                  key: m.id,
                  type: 'button',
                  className: 'dsh-imagegen-menu-item' + (m.id === state.model ? ' is-active' : ''),
                  onClick: () => pick(m.id),
                },
                  h('span', null, shortModel(m.id)),
                  m.activated === 'Available'
                    ? h('span', { className: 'dsh-imagegen-badge' }, '已开通')
                    : m.activated === 'Unavailable'
                      ? h('span', { className: 'dsh-imagegen-badge is-muted' }, '未开通')
                      : null,
                ),
              ),
            )
          : null,
      )
    }

    const CSS = `
.dsh-imagegen-settings{display:flex;flex-direction:column;gap:16px;padding:4px 2px 32px;max-width:760px}
.dsh-imagegen-header h2{margin:0 0 6px;font-size:18px;color:var(--dsw-alias-label-primary)}
.dsh-imagegen-header p{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dsh-imagegen-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3)}
.dsh-imagegen-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-imagegen-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-imagegen-section-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-imagegen-subtitle{margin-top:10px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.dsh-imagegen-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.dsh-imagegen-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-imagegen-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-imagegen-field{display:flex;flex-direction:column;gap:6px}
.dsh-imagegen-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-imagegen-input{flex:1 1 240px;min-width:180px;padding:7px 10px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);outline:none}
.dsh-imagegen-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,rgba(0,0,0,.08))}
.dsh-imagegen-picker{position:relative;display:inline-flex;min-width:200px}
.dsh-imagegen-picker-btn{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:7px 10px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);cursor:pointer}
.dsh-imagegen-picker-btn:disabled{opacity:.55;cursor:default}
.dsh-imagegen-picker-btn:hover{border-color:var(--dsw-alias-state-business-primary)}
.dsh-imagegen-picker-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-imagegen-btn{padding:7px 12px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);cursor:pointer}
.dsh-imagegen-btn:hover{border-color:var(--dsw-alias-state-business-primary)}
.dsh-imagegen-btn:disabled{opacity:.55;cursor:default}
.dsh-imagegen-btn.is-primary{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dsh-imagegen-link{padding:0;font-size:12px;color:var(--dsw-alias-state-business-primary);background:none;border:none;cursor:pointer;text-align:left}
.dsh-imagegen-nested{display:flex;flex-direction:column;gap:10px;padding:12px;border-left:2px solid var(--dsw-alias-border-l4)}
.dsh-imagegen-callout{padding:9px 12px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-4);border-radius:var(--dsw-radius-sm)}
.dsh-imagegen-callout.is-error{color:#d4380d}
.dsh-imagegen-kv{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:4px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-imagegen-toggle{position:relative;width:42px;height:24px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-4);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l4);cursor:pointer;transition:background .16s}
.dsh-imagegen-toggle.is-on{background:var(--dsw-alias-state-business-primary)}
.dsh-imagegen-toggle-knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .16s}
.dsh-imagegen-toggle.is-on .dsh-imagegen-toggle-knob{transform:translateX(18px)}
.dsh-imagegen-toolrow{position:relative;display:inline-flex;align-items:center;gap:2px}
.dsh-imagegen-trigger{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);background:none;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}
.dsh-imagegen-trigger:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}
.dsh-imagegen-trigger:disabled{opacity:.55;cursor:default}
.dsh-imagegen-trigger.is-on{color:var(--dsw-alias-state-business-primary)}
.dsh-imagegen-trigger-icon{font-size:12px;line-height:1}
.dsh-imagegen-trigger-state{font-weight:600}
.dsh-imagegen-trigger-model{max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-imagegen-caret{font-size:9px;opacity:.7}
.dsh-imagegen-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:40;display:flex;flex-direction:column;min-width:190px;padding:4px;background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);box-shadow:0 8px 24px rgba(0,0,0,.18)}
.dsh-imagegen-menu.is-down{top:calc(100% + 6px);bottom:auto;right:0;left:auto}
.dsh-imagegen-menu.is-fixed{position:fixed;top:auto;right:auto;bottom:0;left:0}
.dsh-imagegen-menu-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;font-size:12px;color:var(--dsw-alias-label-primary);background:none;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;text-align:left}
.dsh-imagegen-menu-item:hover{background:var(--dsw-alias-bg-layer-3)}
.dsh-imagegen-menu-item.is-active{color:var(--dsw-alias-state-business-primary)}
.dsh-imagegen-badge{font-size:10px;padding:1px 6px;border-radius:999px;color:var(--dsw-alias-state-business-primary);border:1px solid currentColor}
.dsh-imagegen-badge.is-muted{color:var(--dsw-alias-label-tertiary)}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-imagegen')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        })

        const slots = ctx.get('slots')
        if (!slots) return

        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'dsh-imagegen', order: 208, label: () => '图像生成' }, SettingsPage),
        )
        slots.inject('conversation.input.left', () =>
          slots.register({ name: 'conversation.input.left', id: 'imagegen', order: 6 }, ImagegenControl),
        )
      },
    }
  },
})
