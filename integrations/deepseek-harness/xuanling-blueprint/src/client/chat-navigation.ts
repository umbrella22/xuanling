/** Read-only native navigation. Durable catalog addresses remain Host authority. */
import type { ISessions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface ChatRequest {
  readonly sessionId: string
  readonly requestId: number
}
export interface ChatNavigation {
  getSnapshot(): ChatRequest | null
  subscribe(listener: () => void): () => void
  consume(sessionId: string, requestId: number): boolean
}
export type OpenExecutionChat = (sessionId: string, catalogOwnerId?: string) => Promise<boolean>

export class NativeChatNavigation implements ChatNavigation {
  private services: { sessions: ISessions; workspace: UiWorkspace } | null = null
  private request: ChatRequest | null = null
  private generation = 0
  private removeIntentListeners: (() => void) | null = null
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): ChatRequest | null => this.request
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(request: ChatRequest | null): void {
    this.removeIntentListeners?.()
    this.removeIntentListeners = null
    this.request = request
    if (request !== null) this.watchUserIntent()
    for (const listener of this.listeners) listener()
  }
  private watchUserIntent(): void {
    if (typeof addEventListener === 'function') {
      // The originating pointerdown/keydown already occurred. The next user
      // intent owns its own View choice, even when the target was already Chat.
      const cancel = () => {
        this.generation++
        this.publish(null)
      }
      addEventListener('pointerdown', cancel, true)
      addEventListener('keydown', cancel, true)
      this.removeIntentListeners = () => {
        removeEventListener('pointerdown', cancel, true)
        removeEventListener('keydown', cancel, true)
      }
    }
  }
  readonly consume = (sessionId: string, requestId: number): boolean => {
    if (this.request?.sessionId !== sessionId || this.request.requestId !== requestId) return false
    this.publish(null)
    return true
  }

  /** Owned by an optional Cordis child; removal invalidates pending lookups. */
  connect(sessions: ISessions, workspace: UiWorkspace): () => void {
    const services = { sessions, workspace }
    this.services = services
    return () => {
      if (this.services !== services) return
      this.services = null
      this.generation++
      this.publish(null)
    }
  }

  readonly openSession: OpenExecutionChat = async (sessionId, catalogOwnerId) => {
    const services = this.services,
      requestId = ++this.generation
    this.publish(null)
    if (!services) return false
    this.watchUserIntent()
    // Strict durable DTOs own these IDs. Browser branding stays type-only;
    // importing a Host constructor would violate the native bundle boundary.
    const targetId = sessionId as SessionId
    const resolveTarget = (): SessionTarget | undefined => {
      const address = services.sessions.subagentAddress(targetId)
      if (address !== undefined) return address
      const list = services.sessions.list.getSnapshot(),
        summary = list.byId[targetId]
      // byId also contains retained child fallbacks. Listed conversations,
      // including ordinary forks with parentId, open by identity; subagents
      // still require their native address.
      return list.ids.includes(targetId) && summary !== undefined && summary.origin !== 'subagent' ? targetId : undefined
    }
    try {
      let target = resolveTarget()
      if (target === undefined && catalogOwnerId !== undefined) {
        await services.sessions.refreshProjections(catalogOwnerId as SessionId)
        target = resolveTarget()
      }
      if (target === undefined || this.services !== services || requestId !== this.generation) {
        if (requestId === this.generation) this.publish(null)
        return false
      }
      this.publish({ sessionId, requestId })
      services.workspace.openSession(target)
      return true
    } catch {
      if (requestId === this.generation) this.publish(null)
      return false
    }
  }
}
