import { Injectable } from '@nestjs/common'
import * as k8s from '@kubernetes/client-node'
import { watchSessionProvisioning } from './provision-watch'

/**
 * Where per-session durable storage is mounted in the worker pod.
 * Injected into the pod as SESSION_STORAGE_PATH and reused as the volume
 * mountPath so the mount location and the worker's env value cannot diverge.
 */
const SESSION_STORAGE_PATH = '/data/teiwah'

@Injectable()
export class K8sService {
  private readonly kubeConfig: k8s.KubeConfig
  private k8sApi: k8s.AppsV1Api
  private coreApi: k8s.CoreV1Api
  private networkingApi: k8s.NetworkingV1Api

  constructor() {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault() // Loads from ~/.kube/config
    this.kubeConfig = kc
    this.k8sApi = kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api)
    this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api)
  }

  /**
   * Delete teardown helper. A 404 means the resource is already gone — log and
   * continue so retries stay idempotent. Any other API error propagates to the
   * caller.
   */
  private rethrowUnlessNotFound(error: unknown, message: string): void {
    if (error instanceof k8s.ApiException && error.code === 404) {
      log.warn(error, message)
      return
    }
    throw error
  }

  /**
   * Bounded pod + deployment watch after create — logs provisionState transitions.
   * Does not block callers; safe to fire-and-forget from POST /sessions.
   */
  startProvisioningWatch(sessionId: string): void {
    watchSessionProvisioning(this.kubeConfig, sessionId).catch((error) => {
      log.error(error, `Provision watch failed for session ${sessionId}`)
    })
  }

  /**
   * Provision all k8s resources for a session worker: PVC, Deployment, Service,
   * Traefik middleware, and Ingress. Throws if any create call fails — no DB
   * row should exist until this succeeds.
   */
  async createSessionWorker(sessionId: string) {
    const namespace = env.K8S_NAMESPACE
    const workerPort = Number(env.SESSION_WORKER_PORT)

    // 1. Create Deployment
    const deployment: k8s.V1Deployment = {
      metadata: {
        name: sessionId,
        labels: { app: sessionId }
      },
      spec: {
        replicas: 1,
        // RWO PVC: a RollingUpdate would deadlock (the new pod cannot mount the
        // volume while the old pod still holds it). Recreate stops the old pod first.
        strategy: { type: 'Recreate' },
        selector: {
          matchLabels: { app: sessionId }
        },
        template: {
          metadata: {
            labels: { app: sessionId }
          },
          spec: {
            imagePullSecrets: [{ name: env.IMAGE_PULL_SECRET }],
            containers: [
              {
                name: 'wa-session',
                image: env.SESSION_WORKER_IMAGE,
                // Always: CI overwrites the :amd64 tag; IfNotPresent leaves a stale
                // digest cached on the node and rollout restart won't pick up new builds.
                imagePullPolicy: 'Always',
                ports: [{ containerPort: workerPort }],
                // Worker pod env — full runbook: .env.example (WORKER POD ENV).
                env: [
                  { name: 'SESSION_ID', value: sessionId },
                  { name: 'NODE_ENV', value: 'production' },
                  { name: 'SESSION_STORAGE_PATH', value: SESSION_STORAGE_PATH },
                  {
                    name: 'CONTROL_APP_BASE_URL',
                    value: env.CONTROL_APP_BASE_URL
                  },
                  {
                    name: 'PUBLIC_API_BASE_URL',
                    value: env.PUBLIC_API_BASE_URL
                  },
                  { name: 'PORT', value: env.SESSION_WORKER_PORT },
                  { name: 'LOG_LEVEL', value: env.LOG_LEVEL ?? 'info' },
                  {
                    name: 'BETTERSTACK_SOURCE_TOKEN',
                    value: env.BETTERSTACK_SOURCE_TOKEN
                  },
                  {
                    name: 'BETTERSTACK_INGESTING_HOST',
                    value: env.BETTERSTACK_INGESTING_HOST
                  }
                ],
                // Burstable: reserve 160Mi (density ~22/4GiB node), allow bursts to 224Mi before
                // OOMKill. Tune request to observed P75 once real session usage is measured.
                resources: {
                  requests: {
                    memory: '160Mi',
                    cpu: '50m'
                  },
                  limits: {
                    memory: '224Mi',
                    cpu: '100m'
                  }
                },
                volumeMounts: [
                  { name: 'session-storage', mountPath: SESSION_STORAGE_PATH }
                ]
              }
            ],
            volumes: [
              {
                name: 'session-storage',
                persistentVolumeClaim: { claimName: `${sessionId}-storage` }
              }
            ]
          }
        }
      }
    }

    // 2. Create PersistentVolumeClaim (node-local, k3s local-path) for durable
    // Baileys auth state. Node-pinned: survives in-place restarts, not node moves.
    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: { name: `${sessionId}-storage` },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'local-path',
        resources: { requests: { storage: '1Gi' } }
      }
    }

    // 3. Create Service
    const service: k8s.V1Service = {
      metadata: {
        name: sessionId
      },
      spec: {
        selector: { app: sessionId },
        ports: [
          {
            port: workerPort,
            targetPort: workerPort
          }
        ],
        type: 'ClusterIP' // Internal routing only
      }
    }

    // 4. Create Ingress with Traefik Rewrite Middleware
    const ingress: k8s.V1Ingress = {
      metadata: {
        name: sessionId,
        annotations: {
          'traefik.ingress.kubernetes.io/router.middlewares': `${namespace}-${sessionId}-strip@kubernetescrd`
        }
      },
      spec: {
        ingressClassName: 'traefik-k3s',
        rules: [
          {
            http: {
              paths: [
                {
                  path: `/sessions/${sessionId}`,
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: sessionId,
                      port: { number: workerPort }
                    }
                  }
                }
              ]
            }
          }
        ]
      }
    }

    // 5. Create Traefik Middleware (StripPrefixRegex)
    const middleware = {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: {
        name: `${sessionId}-strip`,
        namespace
      },
      spec: {
        stripPrefixRegex: {
          regex: [`^/sessions/${sessionId}`]
        }
      }
    }

    try {
      log.debug({ sessionId }, 'Creating PersistentVolumeClaim')
      await this.coreApi.createNamespacedPersistentVolumeClaim({
        namespace,
        body: pvc
      })

      log.debug({ sessionId }, 'Creating Deployment')
      await this.k8sApi.createNamespacedDeployment({
        namespace,
        body: deployment
      })

      log.debug({ sessionId }, 'Creating Service')
      await this.coreApi.createNamespacedService({ namespace, body: service })

      log.debug({ sessionId }, 'Creating Traefik Middleware')
      const customApi = new k8s.KubeConfig()
      customApi.loadFromDefault()
      await customApi
        .makeApiClient(k8s.CustomObjectsApi)
        .createNamespacedCustomObject({
          group: 'traefik.io',
          version: 'v1alpha1',
          namespace,
          plural: 'middlewares',
          body: middleware
        })

      log.debug({ sessionId }, 'Creating Ingress')
      await this.networkingApi.createNamespacedIngress({
        namespace,
        body: ingress
      })

      log.info({ sessionId }, 'Created k8s resources for session')
      return { success: true, name: sessionId }
    } catch (error) {
      log.error(error, `Failed to create k8s resources for ${sessionId}`)
      throw error
    }
  }

  /**
   * Tear down all k8s resources for a session worker (reverse of create).
   * Each delete tolerates 404; any other error fails the whole call so the
   * caller can retry before removing the DB row.
   */
  async deleteSessionWorker(sessionId: string) {
    const namespace = env.K8S_NAMESPACE

    try {
      log.debug({ sessionId }, 'Deleting Ingress')
      await this.networkingApi.deleteNamespacedIngress({
        name: sessionId,
        namespace
      })
    } catch (e: unknown) {
      this.rethrowUnlessNotFound(
        e,
        `Failed to delete Ingress ${sessionId} (might not exist)`
      )
    }

    try {
      log.debug({ sessionId }, 'Deleting Traefik Middleware')
      const customApi = new k8s.KubeConfig()
      customApi.loadFromDefault()
      await customApi
        .makeApiClient(k8s.CustomObjectsApi)
        .deleteNamespacedCustomObject({
          group: 'traefik.io',
          version: 'v1alpha1',
          namespace,
          plural: 'middlewares',
          name: `${sessionId}-strip`
        })
    } catch (e: unknown) {
      this.rethrowUnlessNotFound(
        e,
        `Failed to delete Traefik Middleware ${sessionId}-strip (might not exist)`
      )
    }

    try {
      log.debug({ sessionId }, 'Deleting Service')
      await this.coreApi.deleteNamespacedService({
        name: sessionId,
        namespace
      })
    } catch (e: unknown) {
      this.rethrowUnlessNotFound(
        e,
        `Failed to delete Service ${sessionId} (might not exist)`
      )
    }

    try {
      log.debug({ sessionId }, 'Deleting Deployment')
      await this.k8sApi.deleteNamespacedDeployment({
        name: sessionId,
        namespace
      })
    } catch (e: unknown) {
      this.rethrowUnlessNotFound(
        e,
        `Failed to delete Deployment ${sessionId} (might not exist)`
      )
    }

    try {
      log.debug({ sessionId }, 'Deleting PersistentVolumeClaim')
      await this.coreApi.deleteNamespacedPersistentVolumeClaim({
        name: `${sessionId}-storage`,
        namespace
      })
    } catch (e: unknown) {
      this.rethrowUnlessNotFound(
        e,
        `Failed to delete PVC ${sessionId}-storage (might not exist)`
      )
    }

    log.info({ sessionId }, 'Deleted k8s resources for session')
  }
}
