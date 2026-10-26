import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Database, FileCheck2, Loader2, RefreshCw } from 'lucide-react'
import { apiClient } from '@/api/client'
import type { LegacyDiscovery, LegacyDiscoveredSession } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, value)} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}

function formatTimestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString()
}

function sessionSummary(session: LegacyDiscoveredSession): string {
  const provider = session.provider ? ` - ${session.provider}` : ''
  return `${session.message_count} message${session.message_count === 1 ? '' : 's'}${provider}`
}

export function LegacyDataPanel() {
  const toast = useToast()
  const [discovery, setDiscovery] = useState<LegacyDiscovery | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setDiscovery(await apiClient.discoverLegacySessions())
    } catch (error) {
      toast.error(`Could not scan legacy data: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const totals = useMemo(() => {
    if (!discovery) return { stores: 0, sessions: 0, messages: 0 }
    return discovery.stores.reduce(
      (result, store) => ({
        stores: result.stores + 1,
        sessions: result.sessions + store.sessions.length,
        messages: result.messages + store.sessions.reduce((sum, session) => sum + session.message_count, 0),
      }),
      { stores: 0, sessions: 0, messages: 0 },
    )
  }, [discovery])

  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <h2>Legacy session data</h2>
          <p>
            Read-only discovery for session stores from an earlier Python installation. Review what was found before choosing an import action.
          </p>
        </div>
      </div>

      <div className="settings-actions settings-refresh-actions">
        <div>
          <h3 className="text-sm font-semibold">Discovery summary</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {discovery
              ? `${totals.stores} store${totals.stores === 1 ? '' : 's'}, ${totals.sessions} session${totals.sessions === 1 ? '' : 's'}, ${totals.messages} message${totals.messages === 1 ? '' : 's'}`
              : 'Scanning the default locations...'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {loading && !discovery && (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Scanning legacy data...
        </div>
      )}

      {!loading && discovery && discovery.stores.length === 0 && discovery.rejected.length === 0 && (
        <div className="flex flex-col items-center py-10 text-center text-muted-foreground">
          <Database className="mb-2 h-6 w-6 opacity-60" />
          <p className="text-xs">No legacy session stores were found.</p>
        </div>
      )}

      <div className="space-y-2">
        {discovery?.stores.map((store) => (
          <div key={store.path} className="rounded-lg border border-border/75 bg-card/35 px-3 py-3">
            <div className="flex items-start gap-3">
              <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="break-all font-mono text-[11px] text-foreground">{store.path}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {formatBytes(store.size_bytes)} - {store.sessions.length} session{store.sessions.length === 1 ? '' : 's'}
                </p>
                {store.checkpoint_path && (
                  <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <FileCheck2 className="mt-0.5 h-3 w-3 shrink-0" />
                    Checkpoints: <span className="break-all font-mono">{store.checkpoint_path}</span>
                  </p>
                )}
                <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
                  {store.sessions.map((session) => (
                    <div key={session.session_id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px]">
                      <span className="min-w-0 truncate font-medium" title={session.title || session.session_id}>
                        {session.title || session.session_id}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {sessionSummary(session)} - {formatTimestamp(session.updated_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <Badge variant="outline" className="shrink-0 text-[9px]">Read-only</Badge>
            </div>
          </div>
        ))}
      </div>

      {discovery && discovery.rejected.length > 0 && (
        <div className="mt-3 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            Rejected candidates ({discovery.rejected.length})
          </div>
          {discovery.rejected.map((candidate) => (
            <div key={candidate.path} className="text-[11px] text-muted-foreground">
              <p className="break-all font-mono text-foreground">{candidate.path}</p>
              <p>{candidate.reason}</p>
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Discovery does not import, rewrite, or delete legacy files.
      </p>
    </section>
  )
}
