import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'

type DropdownMenuRootProps = React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>

/**
 * App menus should not make every other control on the page inert while they
 * are open. Radix's modal menu mode disables outside pointer events, which
 * means clicking a neighbouring menu trigger first dismisses the old menu and
 * only opens the new one on a second click. A non-modal menu still dismisses
 * on a genuine outside click, while allowing the same pointer event to reach
 * another trigger and switch menus in one click.
 */
const DropdownMenu = ({ modal = false, ...props }: DropdownMenuRootProps) => (
  <DropdownMenuPrimitive.Root {...props} modal={modal} />
)
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuGroup = DropdownMenuPrimitive.Group
// Radix default body portal — Floating UI anchors the menu to its trigger
// and clamps it inside the viewport on every platform. Custom containers +
// stylesheet overrides of the popper wrapper are what pushed menus into the
// top-left corner on real Android devices.
const DropdownMenuPortal = DropdownMenuPrimitive.Portal
const DropdownMenuSub = DropdownMenuPrimitive.Sub
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

type DropdownMenuContentProps = React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
  mobileTitle?: string
}

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>(({ className, sideOffset = 6, mobileTitle = '选项', children, ...props }, ref) => (
  <DropdownMenuPortal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      // Radix v2 dropdown content ALWAYS mounts inside the well-known
      // [data-radix-popper-content-wrapper] body child. On phones the
      // "Overlays v2.1" CSS section neutralizes that wrapper's Floating UI
      // transform and re-anchors it as a deterministic iOS-style bottom
      // sheet — anchor math can never drift to (0,0) again.
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        // macOS-style: larger radius, frosted glass, soft shadow.
        // backdrop-blur-2xl + bg-popover/70 gives the translucent look
        // that lets the underlying chat content show through subtly.
      'z-50 min-w-[10rem] max-w-[calc(100vw-1rem)] max-h-[min(70vh,32rem)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[var(--ui-radius-surface)] border border-border/50 bg-popover/70 p-1.5 text-popover-foreground shadow-lg backdrop-blur-2xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
        className,
      )}
      {...props}
      data-hakus-overlay="menu-content"
    >
      <div aria-hidden className="hakus-sheet-grabber" />
      <div className="hakus-mobile-menu-header">
        <span className="hakus-mobile-menu-title">{mobileTitle}</span>
        <DropdownMenuPrimitive.Item asChild>
          <button type="button" className="hakus-mobile-menu-close" aria-label="关闭">
            <span>关闭</span>
            <X className="h-4 w-4" />
          </button>
        </DropdownMenuPrimitive.Item>
      </div>
      <div className="hakus-mobile-menu-body">{children}</div>
    </DropdownMenuPrimitive.Content>
  </DropdownMenuPortal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      // macOS-style hover: translucent gray instead of blue accent.
      // rounded-lg (not rounded-sm) for softer, more iOS-like items.
      'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors',
      // 菜单项 hover 规范：使用轻量的主题色背景。
      'hover:bg-[var(--cx-ghost-hover)] focus:bg-[var(--cx-ghost-hover)] data-[highlighted]:bg-[var(--cx-ghost-hover)]',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn('px-2.5 py-1.5 text-sm font-semibold', inset && 'pl-8', className)}
    {...props}
  />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1.5 my-1 h-px bg-border/50', className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-[var(--cx-ghost-hover)] data-[state=open]:bg-[var(--cx-ghost-hover)]',
      inset && 'pl-8',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPortal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={8}
      className={cn(
        'z-50 min-w-[8rem] max-w-[calc(100vw-1rem)] max-h-[min(70vh,32rem)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[var(--ui-radius-surface)] border bg-popover p-1.5 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
      data-hakus-overlay="menu-sub-content"
    />
  </DropdownMenuPortal>
))
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
}
