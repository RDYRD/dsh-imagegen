// 干跑 client.js：模拟 ModuleLoader / React / slots，捕获工厂与 apply 的运行时错误。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const file = process.argv[2]
const source = fs.readFileSync(file, 'utf8')

const React = {
  createElement: (type, props, ...children) => ({ $$el: type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
}

const registered = []
const disposed = []
const slots = {
  inject: (name, cb) => {
    try {
      cb()
    } catch (e) {
      console.error('slots.inject handler failed for', name, ':', e.message)
      process.exitCode = 1
    }
  },
  register: (options, component) => {
    registered.push({ name: options.name, id: options.id, label: options.label, order: options.order, kind: typeof component })
    return () => disposed.push(options.name)
  },
}

const ctx = {
  get: (key) => (key === 'slots' ? slots : undefined),
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposed.push('effect')
    return dispose
  },
  inject: (deps, cb) => cb(ctx),
  on: () => {},
  logger: { warn: (...a) => console.warn('[warn]', ...a), info: () => {} },
}

const sandboxWindow = {
  __ModuleLoader__: {
    load: (spec) => {
      console.log('module id:', spec.id)
      const mod = spec.factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
      console.log('factory ok, exports:', Object.keys(mod).join(','))
      if (typeof mod.apply !== 'function') throw new Error('no apply export')
      mod.apply(ctx)
    },
  },
  document: { createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }), head: { appendChild() {} } },
  fetch: async () => ({ json: async () => ({}) }),
}

const context = vm.createContext({ window: sandboxWindow, document: sandboxWindow.document, fetch: sandboxWindow.fetch, console, setTimeout, clearTimeout, URL, encodeURIComponent })
try {
  vm.runInContext(source, context, { filename: path.basename(file) })
} catch (e) {
  console.error('LOAD FAILED:', e.message)
  process.exitCode = 1
}
console.log('registered slots:', JSON.stringify(registered, null, 2))
console.log('disposers:', disposed.length)
