/**
 * Provision watch — bounded Kubernetes watches after POST /sessions.
 *
 * PURPOSE
 *   Log provisioning progress to control logs (`provisionState` field). Does not
 *   drive the board UI yet. Started fire-and-forget from K8sService.startProvisioningWatch.
 *
 * WHAT WE WATCH (in parallel)
 *   1. Deployment named sessionId — rollout conditions (Available, Progressing).
 *   2. Pods with label app=<sessionId> — phase + Ready condition.
 *
 * KUBERNETES WATCH MECHANICS
 *   Each watch is one HTTP GET with ?watch=true. The API server closes the stream
 *   after timeoutSeconds (we pass WATCH_CHUNK_SECONDS, typically one 5‑min chunk).
 *   When the stream ends, runBoundedWatch reconnects until PROVISION_WATCH_TIMEOUT_MS
 *   unless watchCtx.stop is set (success or hard failure).
 *
 * SUCCESS / FAILURE
 *   Success: pod Ready → provision_complete, both watches stop.
 *   Failure: pod Failed or deployment ProgressDeadlineExceeded → stop, no timeout log.
 *   Timeout: 5 min elapsed and pod never Ready → provision_timeout.
 */

import * as k8s from '@kubernetes/client-node'
import type { Logger } from 'pino'

/** Max time to follow one session create (no reconnect after this). */
const PROVISION_WATCH_TIMEOUT_MS = 300_000
/**
 * timeoutSeconds on each watch request. Set equal to overall cap so one stream
 * usually covers a full provision; reconnect only if the server drops early.
 */
const WATCH_CHUNK_SECONDS = 300

/** Logged on each transition; grep control logs for provisionState. */
export type ProvisionState =
  | 'watch_started'
  | 'deployment_scheduled'
  | 'deployment_progressing'
  | 'deployment_available'
  | 'deployment_failed'
  | 'pod_scheduled'
  | 'pod_pending'
  | 'pod_running'
  | 'pod_ready'
  | 'pod_failed'
  | 'provision_complete'
  | 'provision_timeout'

/** Returned from per-event handlers to tell runBoundedWatch to abort the stream. */
type WatchAction = 'continue' | 'stop'

/**
 * Entry point: run deployment + pod watches until done or deadline.
 * Called without await from POST /sessions so HTTP returns immediately.
 */
export async function watchSessionProvisioning(
  kubeConfig: k8s.KubeConfig,
  sessionId: string
): Promise<void> {
  const provisionLog = log.child({ sessionId, component: 'provision-watch' })
  const deadline = Date.now() + PROVISION_WATCH_TIMEOUT_MS

  // Dedup: k8s sends many MODIFIED events for the same phase — log only on change.
  let lastDeploymentState: ProvisionState | null = null
  let lastPodState: ProvisionState | null = null
  let podReady = false

  // Shared flag so finishing one watch (e.g. pod ready) stops the other from reconnecting.
  const watchCtx = { stop: false }

  const emit = (state: ProvisionState, details?: Record<string, unknown>) => {
    provisionLog.info(
      { provisionState: state, ...details },
      `provision: ${state}`
    )
  }

  emit('watch_started', { timeoutMs: PROVISION_WATCH_TIMEOUT_MS })

  const labelSelector = `app=${sessionId}`

  // --- Deployment watch (by name; deployment.metadata.name === sessionId) ---
  const deploymentDone = runBoundedWatch<k8s.V1Deployment>(
    kubeConfig,
    `/apis/apps/v1/namespaces/${env.K8S_NAMESPACE}/deployments`,
    {
      fieldSelector: `metadata.name=${sessionId}`,
      timeoutSeconds: WATCH_CHUNK_SECONDS
    },
    deadline,
    watchCtx,
    (phase, deployment) => {
      // Pod watch already won — don't keep this stream open.
      if (podReady) return 'stop'

      const state = deploymentStateFrom(deployment)
      if (state && state !== lastDeploymentState) {
        lastDeploymentState = state
        emit(state, {
          watchPhase: phase,
          replicas: deployment.status?.replicas,
          readyReplicas: deployment.status?.readyReplicas,
          unavailableReplicas: deployment.status?.unavailableReplicas
        })
      }

      if (state === 'deployment_available' || state === 'deployment_failed') {
        watchCtx.stop = true
        return 'stop'
      }

      return 'continue'
    },
    provisionLog
  )

  // --- Pod watch (worker container; label matches K8sService deployment template) ---
  const podDone = runBoundedWatch<k8s.V1Pod>(
    kubeConfig,
    `/api/v1/namespaces/${env.K8S_NAMESPACE}/pods`,
    { labelSelector, timeoutSeconds: WATCH_CHUNK_SECONDS },
    deadline,
    watchCtx,
    (phase, pod) => {
      const state = podStateFrom(pod)
      if (state && state !== lastPodState) {
        lastPodState = state
        emit(state, {
          watchPhase: phase,
          podPhase: pod.status?.phase,
          podName: pod.metadata?.name,
          node: pod.spec?.nodeName,
          ...podConditionSummary(pod)
        })
      }

      if (state === 'pod_ready') {
        podReady = true
        watchCtx.stop = true
        emit('provision_complete', { podName: pod.metadata?.name })
        return 'stop'
      }

      if (state === 'pod_failed') {
        watchCtx.stop = true
        return 'stop'
      }

      return 'continue'
    },
    provisionLog
  )

  await Promise.all([deploymentDone, podDone])

  // Both watches ended without pod Ready (slow pull, scheduling, crash loop, etc.).
  if (!podReady) {
    emit('provision_timeout', { lastDeploymentState, lastPodState })
  }
}

// -----------------------------------------------------------------------------
// Map k8s objects → ProvisionState (coarse stages for logs, not full object dump)
// -----------------------------------------------------------------------------

function deploymentStateFrom(
  deployment: k8s.V1Deployment
): ProvisionState | null {
  const conditions = deployment.status?.conditions ?? []
  const progressing = conditions.find((c) => c.type === 'Progressing')
  const available = conditions.find((c) => c.type === 'Available')

  if (available?.status === 'True') {
    return 'deployment_available'
  }

  if (progressing?.reason === 'ProgressDeadlineExceeded') {
    return 'deployment_failed'
  }

  const replicas = deployment.status?.replicas ?? 0
  const updated = deployment.status?.updatedReplicas ?? 0

  if (replicas > 0 && updated > 0) {
    return 'deployment_progressing'
  }

  return 'deployment_scheduled'
}

function podStateFrom(pod: k8s.V1Pod): ProvisionState | null {
  const phase = pod.status?.phase

  if (phase === 'Failed') {
    return 'pod_failed'
  }

  if (isPodReady(pod)) {
    return 'pod_ready'
  }

  if (phase === 'Running') {
    return 'pod_running'
  }

  const scheduled = pod.status?.conditions?.find(
    (c) => c.type === 'PodScheduled'
  )
  if (scheduled?.status === 'True' && phase === 'Pending') {
    const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason
    if (waiting === 'ContainerCreating' || waiting === 'PodInitializing') {
      return 'pod_pending'
    }
    return 'pod_scheduled'
  }

  if (phase === 'Pending') {
    return 'pod_pending'
  }

  return null
}

function isPodReady(pod: k8s.V1Pod): boolean {
  return (
    pod.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True'
  )
}

/** Extra context when a pod is stuck (ImagePullBackOff, CrashLoopBackOff, etc.). */
function podConditionSummary(
  pod: k8s.V1Pod
): Record<string, string | undefined> {
  const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting
  const terminated = pod.status?.containerStatuses?.[0]?.state?.terminated
  return {
    waitingReason: waiting?.reason,
    waitingMessage: waiting?.message,
    terminatedReason: terminated?.reason
  }
}

// -----------------------------------------------------------------------------
// Generic watch loop: open stream → handle events → reconnect until stop/deadline
// -----------------------------------------------------------------------------

/**
 * Watches one API resource path until handler returns 'stop', watchCtx.stop, or deadline.
 *
 * @param path - e.g. /api/v1/namespaces/default/pods
 * @param queryParams - labelSelector / fieldSelector; timeoutSeconds overwritten per chunk
 * @param deadline - absolute ms timestamp (PROVISION_WATCH_TIMEOUT_MS from start)
 * @param watchCtx - shared with sibling watch so pod ready stops deployment reconnects
 * @param handler - receives k8s event type (ADDED, MODIFIED, DELETED) and the object
 */
async function runBoundedWatch<T>(
  kubeConfig: k8s.KubeConfig,
  path: string,
  queryParams: Record<string, string | number | boolean | undefined>,
  deadline: number,
  watchCtx: { stop: boolean },
  handler: (phase: string, obj: T) => WatchAction,
  provisionLog: Logger
): Promise<void> {
  const watch = new k8s.Watch(kubeConfig)
  let activeController: AbortController | undefined
  let stopped = false

  const stop = () => {
    stopped = true
    activeController?.abort()
  }

  const connect = async (): Promise<void> => {
    if (stopped || watchCtx.stop || Date.now() >= deadline) {
      return
    }

    // Don't ask k8s to keep the stream open longer than time left on the 5 min budget.
    const remainingMs = deadline - Date.now()
    const timeoutSeconds = Math.max(
      1,
      Math.min(WATCH_CHUNK_SECONDS, Math.ceil(remainingMs / 1000))
    )

    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }

      watch
        .watch(
          path,
          { ...queryParams, timeoutSeconds },
          (phase, obj) => {
            if (stopped) return
            try {
              if (handler(phase, obj as T) === 'stop') {
                stop()
                finish()
              }
            } catch (error) {
              provisionLog.error(error, 'provision watch handler error')
              stop()
              finish()
            }
          },
          // Stream ended (normal server timeout, network, or SERVER_SIDE_CLOSE).
          (err) => {
            activeController = undefined
            if (stopped) {
              finish()
              return
            }
            if (err && err !== k8s.Watch.SERVER_SIDE_CLOSE) {
              provisionLog.warn(
                { err },
                'provision watch stream closed with error; reconnecting'
              )
            }
            finish()
          }
        )
        .then((controller) => {
          activeController = controller
        })
        .catch((error) => {
          provisionLog.error(error, 'provision watch failed to start')
          stop()
          finish()
        })
    }).then(() => {
      // Re-open watch unless we succeeded, failed, or hit the 5 min cap.
      if (!stopped && !watchCtx.stop && Date.now() < deadline) {
        return connect()
      }
    })
  }

  await connect()
}
