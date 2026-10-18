/** Native contribution bootstrap; panel seats belong to a namespace-ready child fiber. */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import TYPERT_REMOTE from '../typert.remote.ts'
import { createBlueprintPanel } from './features/authoring/ui/panel/panel-composition.tsx'
import { resolveBlueprintHost } from './adapters/host/remote.ts'
import type { ModelCatalogLink } from './adapters/host/remote.ts'
import { installCanvasStyles } from './shared/styles/styles.ts'
import { BLUEPRINT_LOCALE, en, zh } from './shared/i18n/locales.ts'
import { ConversationController, resolveConversationHost } from './features/conversation/logic/conversation-controller.ts'
import { ConversationBlueprintView } from './features/conversation/ui/conversation-view.tsx'
import type { ConversationViewInjected } from './features/conversation/ui/conversation-view.tsx'
import { NativeChatNavigation } from './features/conversation/logic/chat-navigation.ts'

interface SlotsRuntime {
  inject(key: string, register: () => () => void): () => void
  register<Props>(options: Record<string, unknown>, component: React.ComponentType<Props>): () => void
}

const PANEL_ID = 'xuanling-blueprint'

// The parent supplies its own namespace; injecting it here would deadlock boot.
export const inject = ['slots', 'remote', 'locale'] as const

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(BLUEPRINT_LOCALE, { zh, en }), 'xuanling-blueprint: dictionaries')
  const remote = ctx.get('remote') as TypertClientRemote
  const disposeMount = await remote.$mount(TYPERT_REMOTE)
  const navigation = new NativeChatNavigation()
  const nativeNavigation = ctx.plugin({
    inject: ['sessions', 'uiWorkspace'],
    apply: scope => {
      scope.effect(() => navigation.connect(scope.get('sessions') as unknown as ISessions, scope.uiWorkspace), 'xuanling-blueprint: native chat navigation')
    }
  })
  const panel = ctx.plugin({
    inject: ['slots', 'remote.blueprint', 'locale'],
    apply: scope => applyPanel(scope, navigation)
  })
  // Optional session services may arrive later. Do not await this child: the
  // global workspace must remain usable without a conversation environment.
  const conversation = ctx.plugin({
    inject: ['slots', 'remote.blueprint', 'uiSession', 'sessions', 'locale'],
    apply: scope => applyConversation(scope, navigation)
  })
  try {
    await panel
  } catch (error) {
    await conversation.dispose()
    await nativeNavigation.dispose()
    await panel.dispose()
    await disposeMount()
    console.error('[xuanling-blueprint] client apply failed:', error)
    throw error
  }
  // Both effects are also scoped by Cordis. Dispose the child first so no
  // visible panel retains a HostLink after its own contribution is withdrawn.
  return async () => {
    await conversation.dispose()
    await nativeNavigation.dispose()
    await panel.dispose()
    await disposeMount()
  }
}

function applyConversation(ctx: Context, navigation: NativeChatNavigation): void {
  const slots = ctx.get('slots') as SlotsRuntime
  const host = resolveConversationHost(ctx)
  const t = ctx.locale.bind(BLUEPRINT_LOCALE)
  // One projection per controller-owned Session generation. History choice
  // survives tab unmount, without retaining or creating a Host Session.
  const controllers = new WeakMap<SessionBinding, ConversationController>()
  const sessions = ctx.get('sessions') as unknown as ISessions
  ctx.effect(
    () =>
      slots.inject('conversation.view', () =>
        slots.register(
          {
            name: 'conversation.view',
            id: PANEL_ID,
            order: 20,
            locale: BLUEPRINT_LOCALE,
            label: () => t('conversation.label'),
            inject: (sessionId: ConvViewProps['sessionId']): ConversationViewInjected => {
              const binding = sessions.binding(sessionId)
              if (!binding) throw new Error('xuanling-blueprint: session-unavailable')
              let controller = controllers.get(binding)
              if (!controller) {
                controller = new ConversationController(host, sessionId)
                controllers.set(binding, controller)
              }
              return {
                controller,
                openSession: (target, owner = sessionId) => navigation.openSession(target, owner),
                chatNavigation: navigation
              }
            }
          },
          ConversationBlueprintView
        )
      ),
    'xuanling-blueprint: conversation seat'
  )
}

function applyPanel(ctx: Context, navigation: NativeChatNavigation): void {
  const slots = ctx.get('slots') as SlotsRuntime
  const hostLink = resolveBlueprintHost(ctx)
  // Session is a sibling Remote namespace owned by DSH's session controller.
  // Resolve it in a child fiber so hosts without the optional session client can
  // still mount the Blueprint panel. The Web profile supplies the native
  // `remote.session.modelCatalog()` implementation through this dependency.
  const modelCatalogReady =
    typeof ctx.inject === 'function'
      ? new Promise<ModelCatalogLink | undefined>(resolve => {
          ctx.inject(['remote.session'], scope => {
            resolve(scope.get('remote.session') as ModelCatalogLink)
          })
        })
      : Promise.resolve(undefined)
  const t = ctx.locale.bind(BLUEPRINT_LOCALE)
  installCanvasStyles()

  const Panel = createBlueprintPanel({
    hostLink,
    modelCatalogReady,
    openSession: navigation.openSession,
    storage: typeof localStorage === 'undefined' ? undefined : localStorage
  })

  // Sidebar entry: a compact icon button in the panellist (keyed by PANEL_ID).
  const PanelIcon = (props: { size?: number; active?: boolean }) =>
    React.createElement(
      'svg',
      {
        width: props.size ?? 18,
        height: props.size ?? 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        'aria-hidden': true
      },
      React.createElement('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 })
    )

  ctx.effect(
    () =>
      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 91,
            label: () => t('panel.label')
          },
          PanelIcon
        )
      ),
    'xuanling-blueprint: sidebar seat'
  )

  // Main content: the keyed page swapped in when the sidebar row activates
  // (AppFrame renders renderSlot('main', {}, { entryKey: activePanelId })).
  ctx.effect(
    () =>
      slots.inject('main', () =>
        slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: BLUEPRINT_LOCALE
          },
          Panel
        )
      ),
    'xuanling-blueprint: main seat'
  )
}
