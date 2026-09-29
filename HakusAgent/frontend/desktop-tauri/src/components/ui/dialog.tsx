import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
// Portal to document.body (Radix default). Floating UI / Radix position
// fixed-layer content against the viewport; the stock body portal is the
// single most battle-tested path across WebView2, macOS and Android WebView.
// The previous app-owned overlay container plus stylesheet overrides is
// exactly what let dialogs drift to the top-left on real devices.
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
      data-hakus-overlay="dialog-overlay"
    />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { fullscreen?: boolean }
>(({ className, children, fullscreen = false, style, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        fullscreen
          ? // Fullscreen surface (settings). No centering utilities at all —
            // Radix's left-1/2/top-1/2/-translate-* combo is exactly what
            // drifted to the top-left corner on some WebView builds.
            'fixed z-50 flex flex-col overflow-hidden bg-background'
          : // Transform-free centering: inset-0 + margin auto resolves the
            // box against the viewport on every WebView, while translate/-
            // transform centering silently breaks when any ancestor gains
            // a transform/filter (fixed elements then anchor to that box).
            'fixed inset-0 z-50 m-auto grid h-fit w-[calc(100%-2rem)] max-w-lg gap-4 border bg-background p-6 shadow-lg duration-200 sm:rounded-[var(--ui-radius-surface)]',
        className,
      )}
      {...props}
      // Inline styles win over every stylesheet/Tailwind layer, so the
      // fullscreen geometry is guaranteed on desktop WebView2 AND Android
      // WebView regardless of viewport quirks (100dvh, zoom, media queries).
      style={
        fullscreen
          ? {
              position: 'fixed',
              // Longhand offsets — the `inset` shorthand is unavailable on
              // older Android WebViews and would drop the geometry entirely.
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              width: '100%',
              height: '100%',
              maxWidth: '100%',
              maxHeight: '100%',
              transform: 'none',
              translate: 'none',
              padding: 0,
              paddingTop: 'env(safe-area-inset-top)',
              ...style,
            }
          : style
      }
      data-hakus-overlay="dialog-content"
    >
      {children}
      {/* Radix auto-focuses the first focusable element (= this close button)
          on open, so any always-on focus ring here lights up a box around the
          X the moment a dialog appears. Keep the button visually quiet on
          focus; hover is the affordance. */}
      <DialogPrimitive.Close className="dialog-close absolute right-4 top-4 rounded-md opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:opacity-100 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-left', className)} {...props} />
)

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
)

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
