import { Injectable } from '@nestjs/common'
import * as k8s from '@kubernetes/client-node'

@Injectable()
export class K8sService {
  private k8sApi: k8s.AppsV1Api
  private coreApi: k8s.CoreV1Api
  private networkingApi: k8s.NetworkingV1Api

  constructor() {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault() // Loads from ~/.kube/config
    this.k8sApi = kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api)
    this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api)
  }

  async createSessionWorker(sessionId: string) {
    const namespace = 'default'

    // 1. Create Deployment
    const deployment: k8s.V1Deployment = {
      metadata: {
        name: sessionId,
        labels: { app: sessionId }
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { app: sessionId }
        },
        template: {
          metadata: {
            labels: { app: sessionId }
          },
          spec: {
            containers: [
              {
                name: 'wa-session',
                image: 'teiwah-session-app:local',
                imagePullPolicy: 'Never', // Use local image
                ports: [{ containerPort: 5335 }],
                env: [
                  { name: 'SESSION_ID', value: sessionId },
                  {
                    name: 'CONTROL_APP_BASE_URL',
                    value: env.CONTROL_APP_BASE_URL
                  },
                  { name: 'NODE_ENV', value: 'production' },
                  { name: 'PORT', value: '5335' }
                ],
                resources: {
                  requests: {
                    memory: '64Mi',
                    cpu: '50m'
                  },
                  limits: {
                    memory: '256Mi',
                    cpu: '200m'
                  }
                }
              }
            ]
          }
        }
      }
    }

    // 2. Create Service
    const service: k8s.V1Service = {
      metadata: {
        name: sessionId
      },
      spec: {
        selector: { app: sessionId },
        ports: [
          {
            port: 5335,
            targetPort: 5335
          }
        ],
        type: 'ClusterIP' // Internal routing only
      }
    }

    // 3. Create Ingress with Traefik Rewrite Middleware
    const ingress: k8s.V1Ingress = {
      metadata: {
        name: sessionId,
        annotations: {
          'traefik.ingress.kubernetes.io/router.middlewares': `default-${sessionId}-strip@kubernetescrd`
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
                      port: { number: 5335 }
                    }
                  }
                }
              ]
            }
          }
        ]
      }
    }

    // 4. Create Traefik Middleware (StripPrefixRegex)
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
      log.info(`Creating Deployment for session ${sessionId}...`)
      await this.k8sApi.createNamespacedDeployment({
        namespace,
        body: deployment
      })

      log.info(`Creating Service for session ${sessionId}...`)
      await this.coreApi.createNamespacedService({ namespace, body: service })

      log.info(`Creating Traefik Middleware for session ${sessionId}...`)
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

      log.info(`Creating Ingress for session ${sessionId}...`)
      await this.networkingApi.createNamespacedIngress({
        namespace,
        body: ingress
      })

      return { success: true, name: sessionId }
    } catch (error) {
      log.error(error, `Failed to create k8s resources for ${sessionId}`)
      throw error
    }
  }

  async deleteSessionWorker(sessionId: string) {
    const namespace = 'default'

    try {
      log.info(`Deleting Ingress for session ${sessionId}...`)
      await this.networkingApi.deleteNamespacedIngress({
        name: sessionId,
        namespace
      })
    } catch (e: unknown) {
      log.warn(e, `Failed to delete Ingress ${sessionId} (might not exist)`)
    }

    try {
      log.info(`Deleting Traefik Middleware for session ${sessionId}...`)
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
      log.warn(
        e,
        `Failed to delete Traefik Middleware ${sessionId}-strip (might not exist)`
      )
    }

    try {
      log.info(`Deleting Service for session ${sessionId}...`)
      await this.coreApi.deleteNamespacedService({
        name: sessionId,
        namespace
      })
    } catch (e: unknown) {
      log.warn(e, `Failed to delete Service ${sessionId} (might not exist)`)
    }

    try {
      log.info(`Deleting Deployment for session ${sessionId}...`)
      await this.k8sApi.deleteNamespacedDeployment({
        name: sessionId,
        namespace
      })
    } catch (e: unknown) {
      log.warn(e, `Failed to delete Deployment ${sessionId} (might not exist)`)
    }
  }
}
