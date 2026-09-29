import { invoke } from '@tauri-apps/api/core'

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAction {
  action: 'navigate' | 'clear' | 'snapshot' | 'click' | 'fill' | 'press' | 'scroll' | 'back' | 'forward' | 'reload' | 'open_tab' | 'switch_tab' | 'close_tab' | 'list_tabs'
  url?: string
  tabId?: string
  selector?: string
  text?: string
  value?: string
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
}

const browserActions = new Set<BrowserAction['action']>([
  'navigate', 'clear', 'snapshot', 'click', 'fill', 'press', 'scroll',
  'back', 'forward', 'reload', 'open_tab', 'switch_tab', 'close_tab', 'list_tabs',
])
const browserActionKeys = new Set([
  'action', 'url', 'tabId', 'selector', 'text', 'value', 'key', 'direction', 'amount',
])

export function parseBrowserAction(input: unknown): BrowserAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Browser action must be an object')
  }
  const value = input as Record<string, unknown>
  if (typeof value.action !== 'string' || !browserActions.has(value.action as BrowserAction['action'])) {
    throw new Error('Unsupported browser action')
  }
  if (Object.keys(value).some((key) => !browserActionKeys.has(key))) {
    throw new Error('Browser action contains unsupported fields')
  }

  for (const key of ['url', 'tabId', 'selector', 'text', 'value', 'key', 'direction'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`Browser action field ${key} must be a string`)
    }
  }
  if (value.amount !== undefined && (!Number.isInteger(value.amount) || Number(value.amount) < 50 || Number(value.amount) > 1500)) {
    throw new Error('Browser scroll amount must be an integer from 50 to 1500')
  }

  const action = value.action as BrowserAction['action']
  if (action === 'navigate' && !value.url) throw new Error('Navigate requires a URL')
  if (action === 'switch_tab' && !value.tabId) throw new Error('Switch tab requires a tab ID')
  if (action === 'click' && !value.selector && !value.text) throw new Error('Click requires a selector or text')
  if (action === 'fill' && (!value.selector || value.value === undefined)) throw new Error('Fill requires a selector and value')
  if (action === 'press' && !value.key) throw new Error('Press requires a key')
  if (action === 'scroll' && !['up', 'down', 'left', 'right'].includes(String(value.direction))) {
    throw new Error('Scroll requires a valid direction')
  }

  return value as unknown as BrowserAction
}

export const BROWSER_DYNAMIC_TOOL = {
  namespace: 'browser',
  name: 'control',
  description: 'Control the in-app browser. Use list_tabs to inspect tabs, open_tab to open a page, switch_tab before acting on another tab, and snapshot before selecting page targets. Supported page actions: navigate, clear, snapshot, click, fill, press, scroll, back, forward, reload. Do not execute purchases, submissions, or other irreversible actions without the user\'s confirmation.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['navigate', 'clear', 'snapshot', 'click', 'fill', 'press', 'scroll', 'back', 'forward', 'reload', 'open_tab', 'switch_tab', 'close_tab', 'list_tabs'] },
      url: { type: 'string' },
      tabId: { type: 'string' },
      selector: { type: 'string' },
      text: { type: 'string' },
      value: { type: 'string' },
      key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', minimum: 50, maximum: 1500 },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const

type BrowserPanelDriver = {
  execute: (action: BrowserAction) => Promise<string>
}

let panelDriver: BrowserPanelDriver | null = null
let lifecycleQueue: Promise<unknown> = Promise.resolve()

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const next = lifecycleQueue.then(operation, operation)
  lifecycleQueue = next.then(() => undefined, () => undefined)
  return next
}

export function embeddedBrowserAvailable(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return '__TAURI_INTERNALS__' in window && !/android/i.test(navigator.userAgent)
}

export function registerBrowserPanel(driver: BrowserPanelDriver): () => void {
  panelDriver = driver
  return () => {
    if (panelDriver === driver) panelDriver = null
  }
}

export async function executeAgentBrowserAction(input: unknown): Promise<string> {
  const deadline = Date.now() + 15000
  while (!panelDriver && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }
  if (!panelDriver) throw new Error('The browser panel did not become available')
  return panelDriver.execute(parseBrowserAction(input))
}

export const browserOs = {
  create: (tabId: string, bounds: BrowserBounds) =>
    serializeLifecycle(() => invoke<void>('browser_create', { tabId, bounds })),
  setBounds: (tabId: string, bounds: BrowserBounds) =>
    serializeLifecycle(() => invoke<void>('browser_set_bounds', { tabId, bounds })),
  select: (tabId: string, tabIds: string[], bounds: BrowserBounds, showPage: boolean) =>
    serializeLifecycle(() => invoke<void>('browser_select_tab', { tabId, tabIds, bounds, showPage })),
  hideTabs: (tabIds: string[]) =>
    serializeLifecycle(() => invoke<void>('browser_hide_tabs', { tabIds })),
  closeTab: (tabId: string) =>
    serializeLifecycle(() => invoke<void>('browser_close_tab', { tabId })),
  suspend: (tabIds: string[]) => serializeLifecycle(() => invoke<void>('browser_hide_tabs', { tabIds })),
  action: (tabId: string, action: BrowserAction) =>
    invoke<Record<string, unknown>>('browser_action', { tabId, action }),
  currentUrl: (tabId: string) => invoke<string>('browser_current_url', { tabId }),
}
