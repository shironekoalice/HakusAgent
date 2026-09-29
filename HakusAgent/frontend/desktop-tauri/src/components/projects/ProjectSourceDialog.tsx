import { FolderOpen, Globe2, ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '@/lib/i18n'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLocal: () => void
  onRemote: () => void
}

const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

/** Shared first step for every project-creation entry point. */
export function ProjectSourceDialog({ open, onOpenChange, onLocal, onRemote }: Props) {
  const { locale } = useI18n()
  const copy = (zh: string, en: string) => locale === 'zh-CN' ? zh : en

  const chooseLocal = () => {
    onOpenChange(false)
    onLocal()
  }

  const chooseRemote = () => {
    onOpenChange(false)
    onRemote()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-5">
        <DialogHeader>
          <DialogTitle>{copy('新建项目', 'New project')}</DialogTitle>
          <DialogDescription>{copy('选择项目所在的位置。', 'Choose where this project lives.')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={chooseLocal}
            className="group flex min-h-32 items-center gap-3 rounded-md border border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary">
              <FolderOpen className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{copy('打开文件夹', 'Open folder')}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{copy('从本机选择一个工作目录。', 'Choose a workspace folder on this device.')}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>

          {!IS_ANDROID && (
            <button
              type="button"
              onClick={chooseRemote}
              className="group flex min-h-32 items-center gap-3 rounded-md border border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary">
                <Globe2 className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{copy('远程连接', 'Remote connection')}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{copy('连接 SSH、WSL 或 Docker 工作目录。', 'Connect to an SSH, WSL, or Docker workspace.')}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
