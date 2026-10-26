import { lazy, Suspense } from 'react'
import type { RemoteProjectWizardProps } from './RemoteProjectWizard'

const RemoteProjectWizard = lazy(() => import('./RemoteProjectWizard').then((module) => ({
  default: module.RemoteProjectWizard,
})))

/** Keep the remote connection form out of the default desktop payload. */
export function DeferredRemoteProjectWizard(props: RemoteProjectWizardProps) {
  if (!props.open) return null

  return (
    <Suspense fallback={null}>
      <RemoteProjectWizard {...props} />
    </Suspense>
  )
}
