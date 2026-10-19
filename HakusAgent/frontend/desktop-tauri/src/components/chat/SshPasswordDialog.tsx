import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { KeyRound, Loader2, X, Check } from 'lucide-react'
import { apiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface SshPasswordApproval {
  approvalId: string
  runId: string
  workerId: string
}

interface Props {
  approval: SshPasswordApproval | null
  onClose: () => void
}

/** Secure-input boundary for Runtime Fleet SSH password approvals. */
export function SshPasswordDialog({ approval, onClose }: Props) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setPassword('')
    setError('')
    setSubmitting(false)
  }, [approval?.approvalId])

  if (!approval) return null

  const submit = async () => {
    if (!password || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await apiClient.provisionRuntimeFleetSshPassword(approval.runId, approval.workerId, password)
      setPassword('')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to provision the SSH password')
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[530] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={onClose} role="presentation" />
      <div role="dialog" aria-modal="true" aria-labelledby="ssh-password-title" className="relative w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><KeyRound className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1">
            <h2 id="ssh-password-title" className="text-sm font-semibold">SSH password required</h2>
            <p className="mt-1 text-xs text-muted-foreground">Worker {approval.workerId} is waiting for secure authentication.</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>
        <div className="mt-5 space-y-2">
          <label htmlFor="fleet-ssh-password" className="text-xs text-muted-foreground">Password</label>
          <Input id="fleet-ssh-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={submitting || !password} onClick={() => void submit()}>{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Submit</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
