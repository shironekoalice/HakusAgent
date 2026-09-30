import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ClipboardPaste, Copy, Redo2, Scissors, Undo2 } from 'lucide-react'
import { clipboardOs } from '@/api/tauriBridge'
import { copyToClipboard } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { toastApi } from '@/components/ui/toast'
import { LiquidGlassSurface } from '@/components/ui/liquid-glass-surface'

type TextControl = HTMLInputElement | HTMLTextAreaElement
type EditableTarget = TextControl | HTMLElement

interface MenuState {
  x: number
  y: number
  editor: EditableTarget | null
  start: number | null
  end: number | null
  range: Range | null
  selectedText: string
  editable: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
}

const INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'week', 'time',
])

function findEditor(target: EventTarget | null): EditableTarget | null {
  if (!(target instanceof HTMLElement)) return null
  const editor = target.closest<HTMLElement>(
    'textarea, input, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  )
  if (!editor || editor.getAttribute('aria-disabled') === 'true') return null
  if (editor instanceof HTMLInputElement) {
    if (!INPUT_TYPES.has(editor.type) || editor.disabled) return null
    return editor
  }
  if (editor instanceof HTMLTextAreaElement) return editor.disabled ? null : editor
  return editor.isContentEditable || editor.getAttribute('role') === 'textbox' ? editor : null
}

function selectionFor(editor: EditableTarget | null): {
  start: number | null
  end: number | null
  range: Range | null
  text: string
} {
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    try {
      const start = editor.selectionStart
      const end = editor.selectionEnd
      return { start, end, range: null, text: start === null || end === null ? '' : editor.value.slice(start, end) }
    } catch {
      return { start: null, end: null, range: null, text: '' }
    }
  }
  if (editor) {
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
    return { start: null, end: null, range, text: selection?.toString() || '' }
  }
  const selection = window.getSelection()
  return {
    start: null,
    end: null,
    range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null,
    text: selection?.toString() || '',
  }
}

function restoreSelection(menu: MenuState): void {
  if (menu.editor instanceof HTMLInputElement || menu.editor instanceof HTMLTextAreaElement) {
    menu.editor.focus({ preventScroll: true })
    if (menu.start !== null && menu.end !== null) {
      try {
        menu.editor.setSelectionRange(menu.start, menu.end)
      } catch {
        // Number inputs do not expose a text selection range.
      }
    }
    return
  }
  if (menu.editor) menu.editor.focus({ preventScroll: true })
  if (menu.range) {
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(menu.range)
  }
}

function dispatchInput(target: EditableTarget, inputType: string, data: string | null): void {
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }))
}

async function readClipboardText(): Promise<string> {
  if (typeof __TAURI_INTERNALS__ !== 'undefined') return clipboardOs.readText()
  if (navigator.clipboard?.readText) return navigator.clipboard.readText()
  throw new Error('Clipboard access is unavailable')
}

export function TextContextMenu() {
  const { locale } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [busy, setBusy] = useState(false)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const modifier = isMac ? '⌘' : 'Ctrl'
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!target || target.closest('[data-native-context-menu="true"]')) return
      const editor = findEditor(target)
      const selection = selectionFor(editor)
      if (!editor && !selection.text) return

      event.preventDefault()
      const rect = target.getBoundingClientRect()
      const x = event.clientX || rect.left + Math.min(24, rect.width / 2)
      const y = event.clientY || rect.top + Math.min(24, rect.height / 2)
      const nativeReadOnly = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
        ? editor.readOnly
        : false
      const editable = Boolean(
        editor &&
        !nativeReadOnly &&
        editor.getAttribute('aria-readonly') !== 'true' &&
        editor.getAttribute('aria-disabled') !== 'true' &&
        !editor.hasAttribute('disabled'),
      )
      const canCopy = Boolean(selection.text)
      setMenu({
        x,
        y,
        editor,
        start: selection.start,
        end: selection.end,
        range: selection.range,
        selectedText: selection.text,
        editable,
        canCut: editable && canCopy,
        canCopy,
        canPaste: editable,
      })
    }
    const closeOnPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu(null)
    }
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }

    window.addEventListener('contextmenu', handleContextMenu, true)
    window.addEventListener('pointerdown', closeOnPointerDown, true)
    window.addEventListener('keydown', closeOnKeyDown, true)
    return () => {
      window.removeEventListener('contextmenu', handleContextMenu, true)
      window.removeEventListener('pointerdown', closeOnPointerDown, true)
      window.removeEventListener('keydown', closeOnKeyDown, true)
    }
  }, [])

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const bounds = menuRef.current.getBoundingClientRect()
    const padding = 8
    setPosition({
      x: Math.max(padding, Math.min(menu.x, window.innerWidth - bounds.width - padding)),
      y: Math.max(padding, Math.min(menu.y, window.innerHeight - bounds.height - padding)),
    })
    menuRef.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])

  const run = (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pastePlain' | 'selectAll') => {
    if (!menu) return
    const current = menu
    if (action === 'copy' || action === 'cut') {
      if (!current.selectedText) return
      setBusy(true)
      void copyToClipboard(current.selectedText).then((ok) => {
        if (!ok) {
          toastApi.error(copy('复制失败，无法访问系统剪贴板', 'Copy failed: clipboard access is unavailable'))
          return
        }
        if (action === 'cut' && current.editor && current.editable) {
          restoreSelection(current)
          if (current.editor instanceof HTMLInputElement || current.editor instanceof HTMLTextAreaElement) {
            if (current.start !== null && current.end !== null) {
              current.editor.setRangeText('', current.start, current.end, 'start')
              dispatchInput(current.editor, 'deleteByCut', null)
            }
          } else if (current.range) {
            const selection = window.getSelection()
            selection?.removeAllRanges()
            selection?.addRange(current.range)
            current.range.deleteContents()
            dispatchInput(current.editor, 'deleteByCut', null)
          }
        }
      }).finally(() => {
        setBusy(false)
        setMenu(null)
      })
      return
    }

    if (!current.editor) {
      if (action === 'selectAll') document.execCommand('selectAll')
      setMenu(null)
      return
    }

    restoreSelection(current)
    if (action === 'selectAll') {
      if (current.editor instanceof HTMLInputElement || current.editor instanceof HTMLTextAreaElement) {
        current.editor.select()
      } else {
        const range = document.createRange()
        range.selectNodeContents(current.editor)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    } else if (action === 'undo' || action === 'redo') {
      document.execCommand(action)
    } else {
      setBusy(true)
      void readClipboardText().then((text) => {
        restoreSelection(current)
        if (current.editor instanceof HTMLInputElement || current.editor instanceof HTMLTextAreaElement) {
          const start = current.start ?? current.editor.selectionStart ?? current.editor.value.length
          const end = current.end ?? current.editor.selectionEnd ?? start
          try {
            current.editor.setRangeText(text, start, end, 'end')
            dispatchInput(current.editor, 'insertFromPaste', text)
          } catch {
            const prototype = Object.getPrototypeOf(current.editor) as HTMLInputElement
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
            setter?.call(current.editor, text)
            dispatchInput(current.editor, 'insertFromPaste', text)
          }
        } else {
          const selection = window.getSelection()
          if (current.range && selection) {
            selection.removeAllRanges()
            selection.addRange(current.range)
          }
          if (!document.execCommand('insertText', false, text)) {
            const range = window.getSelection()?.getRangeAt(0)
            if (range) {
              range.deleteContents()
              const textNode = document.createTextNode(text)
              range.insertNode(textNode)
              range.setStartAfter(textNode)
              range.collapse(true)
              selection?.removeAllRanges()
              selection?.addRange(range)
              dispatchInput(current.editor, 'insertFromPaste', text)
            }
          }
        }
      }).catch(() => {
        toastApi.error(copy('粘贴失败，无法读取系统剪贴板', 'Paste failed: clipboard access is unavailable'))
      }).finally(() => {
        setBusy(false)
        setMenu(null)
      })
      return
    }
    setMenu(null)
  }

  if (!menu) return null

  const items = [
    { id: 'undo' as const, label: copy('撤销', 'Undo'), shortcut: `${modifier}+Z`, icon: Undo2, disabled: !menu.editable },
    { id: 'redo' as const, label: copy('重做', 'Redo'), shortcut: isMac ? '⌘+⇧+Z' : 'Ctrl+Y', icon: Redo2, disabled: !menu.editable },
    { separator: true },
    { id: 'cut' as const, label: copy('剪切', 'Cut'), shortcut: `${modifier}+X`, icon: Scissors, disabled: !menu.canCut },
    { id: 'copy' as const, label: copy('复制', 'Copy'), shortcut: `${modifier}+C`, icon: Copy, disabled: !menu.canCopy },
    { id: 'paste' as const, label: copy('粘贴', 'Paste'), shortcut: `${modifier}+V`, icon: ClipboardPaste, disabled: !menu.canPaste || busy },
    { id: 'pastePlain' as const, label: copy('粘贴为纯文本', 'Paste as plain text'), shortcut: `${modifier}+⇧+V`, icon: ClipboardPaste, disabled: !menu.canPaste || busy },
    { separator: true },
    { id: 'selectAll' as const, label: copy('全选', 'Select all'), shortcut: `${modifier}+A`, icon: null, disabled: false },
  ]

  return (
    <LiquidGlassSurface
      ref={menuRef}
      role="menu"
      aria-label={copy('文本编辑菜单', 'Text editing menu')}
      className="text-context-menu"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          restoreSelection(menu)
          setMenu(null)
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const controls = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
        const index = controls.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (index + 1) % controls.length : (index - 1 + controls.length) % controls.length
        controls[next]?.focus()
      }}
    >
      {items.map((item, index) => 'separator' in item ? (
        <div key={`separator-${index}`} role="separator" className="text-context-menu-separator" />
      ) : (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className="text-context-menu-item"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(item.id)}
          title={item.label}
        >
          {item.icon && <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
          {!item.icon && <span className="w-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{item.shortcut}</span>
        </button>
      ))}
    </LiquidGlassSurface>
  )
}
