import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { contextCommands } from '../../src/client/shared/controls/command-policy.ts'
import {
  OBJECT_COMMAND_GROUPS,
  MORE_ACTION_GROUPS,
  preparePublicAction,
  preparePublicCommand,
  preparePublicDisclosure,
  openPublicSubmenu,
  closePublicMore,
  prepareRunInput
} from '../../../../../test/blueprint/capabilities/compact-ui-entry.mjs'
// This adapter models only the locator boundary and records calls; all input
// preparation under test is the actual collector function, not a copied helper.
function publicPage({ old = false, disabled = false } = {}) {
  const state = { menu: false, group: null, open: false, trace: [] }
  const locator = selector => ({
    count: async () => (old && /more-actions|details\[/.test(selector) ? 0 : 1),
    isVisible: async () => {
      if (selector.includes('more-menu')) return state.menu
      if (selector.includes('data-bp-action')) {
        const id = selector.match(/data-bp-action="([^"]+)"/)[1]
        return old || !MORE_ACTION_GROUPS[id] || (state.menu && state.group === MORE_ACTION_GROUPS[id])
      }
      if (selector.includes('data-bp-menu-command')) return old || state.group === OBJECT_COMMAND_GROUPS[selector.match(/data-bp-menu-command="([^"]+)"/)[1]]
      return true
    },
    getAttribute: async name =>
      name === 'aria-haspopup'
        ? 'menu'
        : name === 'aria-expanded'
          ? String(state.group === selector.match(/data-bp-menu-group="([^"]+)"/)?.[1])
          : name === 'role'
            ? 'menu'
            : name === 'open'
              ? state.open
                ? ''
                : null
              : null,
    isDisabled: async () => disabled,
    waitFor: async options => {
      state.trace.push(['wait', selector, options])
      if (options.state === 'visible') assert.equal(await locator(selector).isVisible(), true)
    },
    locator: child => locator(child),
    focus: async () => {
      state.focus = selector
      state.trace.push(['focus', selector])
    },
    click: async options => {
      assert.equal(options?.force, undefined)
      state.trace.push(['click', selector])
      if (selector.includes('more-actions')) state.menu = true
      if (selector.includes('data-bp-menu-group')) state.group = selector.match(/data-bp-menu-group="([^"]+)"/)[1]
      if (selector.includes('summary')) state.open = !state.open
    }
  })
  return {
    state,
    page: {
      locator,
      keyboard: {
        press: async key => {
          state.trace.push(['key', key])
          if (key === 'ArrowRight') state.group = state.focus.match(/data-bp-menu-group="([^"]+)"/)[1]
          if (key === 'Escape') {
            if (state.group) state.group = null
            else state.menu = false
          }
        }
      },
      evaluate: () => {
        throw new Error('input preparation must not evaluate DOM clicks or writes')
      }
    }
  }
}
const facts = {
  hasDefinition: true,
  busy: false,
  canvasLocked: false,
  composing: false,
  selectionCount: 3,
  selectionPinned: false,
  canUndo: true,
  canRedo: true,
  canSave: true,
  canRun: true,
  canCancel: true,
  editable: true
}
const actualCommands = contextCommands('node', facts)
  .map(c => c.command)
  .filter(c => /^(color-|align-|distribute-)/.test(c))
test('public command registry exactly covers all actual policy color/layout commands', () => {
  assert.deepEqual(Object.keys(OBJECT_COMMAND_GROUPS).sort(), actualCommands.sort())
  assert.equal(MORE_ACTION_GROUPS['toggle-minimap'], 'view')
  assert.equal(Object.hasOwn(MORE_ACTION_GROUPS, 'minimap-toggle'), false)
})
for (const command of actualCommands)
  test(`actual public preparation reaches canonical command ${command}`, async () => {
    const { page, state } = publicPage()
    const target = await preparePublicCommand(page, command)
    assert.equal(await target.isVisible(), true)
    assert.equal(state.group, OBJECT_COMMAND_GROUPS[command])
    assert.deepEqual(
      state.trace.filter(t => t[0] === 'click').map(t => t[1]),
      [`[data-bp-menu-group="${OBJECT_COMMAND_GROUPS[command]}"]`]
    )
  })
for (const [id, group] of Object.entries(MORE_ACTION_GROUPS))
  test(`actual public More preparation exposes ${id} through ${group}`, async () => {
    const { page, state } = publicPage({ disabled: true }),
      target = await preparePublicAction(page, id)
    assert.equal(await target.isVisible(), true)
    assert.equal(await target.isDisabled(), true)
    assert.deepEqual(
      state.trace.filter(t => t[0] === 'click').map(t => t[1]),
      ['[data-bp-action="more-actions"]', `[data-bp-menu-group="${group}"]`]
    )
    await closePublicMore(page)
    assert.equal(state.menu, false)
  })
test('legacy public entries do not open new menus or disclosures', async () => {
  const { page, state } = publicPage({ old: true })
  for (const id of Object.keys(MORE_ACTION_GROUPS)) await preparePublicAction(page, id)
  for (const command of actualCommands) await preparePublicCommand(page, command)
  assert.equal(await preparePublicDisclosure(page, 'run'), false)
  assert.equal(
    state.trace.some(t => ['click', 'focus', 'key'].includes(t[0])),
    false
  )
})
test('actual disclosure preparation uses only its visible native summary, is idempotent, and supports keyboard submenu', async () => {
  const { page, state } = publicPage()
  await preparePublicDisclosure(page, 'run')
  await preparePublicDisclosure(page, 'run')
  assert.deepEqual(
    state.trace.filter(t => t[0] === 'click').map(t => t[1]),
    ['summary[data-bp-disclosure-toggle="run"]']
  )
  await openPublicSubmenu(page, page.locator('[data-bp-overlay="more-menu"]'), 'view', { keyboard: true })
  assert.equal(state.group, 'view')
  assert.ok(state.trace.some(t => t[0] === 'key' && t[1] === 'ArrowRight'))
})
test('malformed public submenu ARIA is rejected before an action can execute', async () => {
  const { page } = publicPage(),
    locate = page.locator
  const broken = selector => {
    const target = locate(selector)
    target.getAttribute = async () => null
    target.locator = broken
    return target
  }
  page.locator = broken
  await assert.rejects(openPublicSubmenu(page, page.locator('menu'), 'view'), /trigger lacks menu ARIA/)
})
test('actual Comfy CI-TYPING sequence opens folded Run after reload before original native input and keyboard operations', async () => {
  const source = readFileSync(new URL('../../../../../test/blueprint/capabilities/comfy-interactions-ui.mjs', import.meta.url), 'utf8')
  const typingAt = source.indexOf("    const typing = page.locator('[data-bp-run-input]')")
  const start = source.lastIndexOf("    await selectNodes(page, ['source']); before = await doc()", typingAt)
  const end = source.indexOf('    const cdp = await page.context().newCDPSession(page)', typingAt)
  assert.ok(start >= 0 && typingAt > start && end > typingAt, 'actual CI-TYPING sequence landmarks missing')
  const state = { open: false, focused: false, selected: false, value: '{}', trace: [] }
  const visible = operation => assert.equal(state.open, true, `locator.${operation}: Run input is not visible after reload`)
  const input = {
    waitFor: async options => {
      assert.deepEqual(options, { state: 'visible' })
      visible('waitFor')
      state.trace.push(['wait-visible'])
    },
    fill: async text => {
      visible('fill')
      state.value = text
      state.focused = true
      state.trace.push(['fill', text])
    },
    focus: async () => {
      visible('focus')
      state.focused = true
      state.trace.push(['focus'])
    },
    inputValue: async () => state.value
  }
  const details = {
    count: async () => 1,
    getAttribute: async name => {
      assert.equal(name, 'open')
      return state.open ? '' : null
    },
    locator: selector => {
      assert.equal(selector, 'summary[data-bp-disclosure-toggle="run"]')
      return {
        click: async options => {
          assert.equal(options, undefined)
          state.open = !state.open
          state.trace.push(['summary-click'])
        }
      }
    }
  }
  const page = {
    locator: selector => {
      if (selector === 'details[data-bp-disclosure="run"]') return details
      assert.equal(selector, '[data-bp-run-input]')
      return input
    },
    keyboard: {
      press: async key => {
        visible('keyboard')
        assert.equal(state.focused, true)
        state.trace.push(['key', key])
        if (key === 'ControlOrMeta+a') state.selected = true
        else {
          assert.equal(key, 'Delete')
          assert.equal(state.selected, true)
          state.value = ''
          state.selected = false
        }
      },
      type: async text => {
        visible('keyboard')
        assert.equal(state.focused, true)
        state.value += text
        state.trace.push(['type', text])
      }
    },
    evaluate: () => {
      throw new Error('Run preparation must use its public summary, not DOM mutation')
    }
  }
  const document = { graph: { nodes: [{ id: 'source', kind: 'input' }], edges: [] }, presentation: { nodes: { source: { x: 10, y: 20 } } } }
  const checks = [],
    AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('page', 'selectNodes', 'doc', 'node', 'same', 'check', 'prepareRunInput', `let before;\n${source.slice(start, end)}`)
  await run(
    page,
    async (actualPage, ids) => {
      assert.equal(actualPage, page)
      assert.deepEqual(ids, ['source'])
    },
    async () => structuredClone(document),
    (actualPage, id) => {
      assert.equal(actualPage, page)
      assert.equal(id, 'source')
      return { count: async () => 1 }
    },
    isDeepStrictEqual,
    (id, description, passed) => {
      assert.equal(passed, true, description)
      checks.push(id)
    },
    prepareRunInput
  )
  assert.deepEqual(checks, ['CI-TYPING'])
  assert.deepEqual(state.trace, [
    ['summary-click'],
    ['wait-visible'],
    ['fill', 'native input untouched'],
    ['focus'],
    ['key', 'ControlOrMeta+a'],
    ['key', 'Delete'],
    ['type', 'typing stays input']
  ])
  assert.equal(state.value, 'typing stays input')
})
for (const journey of ['comfy-interactions-ui', 'comfy-motion-ui'])
  for (const compact of [true, false]) {
    test(`actual ${journey} idle observes ${compact ? 'compact top selector' : 'legacy refresh'} busy without activating menus`, async () => {
      const source = readFileSync(new URL(`../../../../../test/blueprint/capabilities/${journey}.mjs`, import.meta.url), 'utf8')
      const start = source.indexOf('async function idle(page)'),
        end = source.indexOf('async function choose(page, id)', start)
      assert.ok(start >= 0 && end > start, 'actual idle source landmarks missing')
      const idle = Function('preparePublicAction', 'closePublicMore', `${source.slice(start, end)}; return idle`)(preparePublicAction, closePublicMore)
      const state = { busy: true, present: true, samples: [], queries: [], clicks: [], waits: 0 }
      let entered,
        ready,
        predicate,
        finished = false
      const waitEntered = new Promise(resolve => {
        entered = resolve
      })
      const waitReady = new Promise(resolve => {
        ready = resolve
      })
      const control = {
        get disabled() {
          return state.busy
        }
      }
      const publicDocument = {
        querySelector: selector => {
          state.queries.push(selector)
          return state.present && selector === (compact ? '[data-bp-select="blueprint"]' : '[data-bp-action="refresh-library"]') ? control : null
        }
      }
      const sample = () => {
        const result = !!Function('document', `return (${predicate.toString()})()`)(publicDocument)
        state.samples.push(result)
        if (result) ready()
        return result
      }
      const page = {
        locator: selector => ({
          count: async () => (selector === '[data-bp-action="more-actions"]' ? Number(compact) : 1),
          isVisible: async () => (selector === '[data-bp-action="refresh-library"]' ? !compact : false),
          click: async () => {
            state.clicks.push(selector)
            assert.fail('idle must not activate More while workspace is busy')
          }
        }),
        waitForFunction: (...args) => {
          assert.equal(args.length, 1, 'idle must preserve its default wait timeout and polling')
          state.waits++
          predicate = args[0]
          sample()
          entered()
          return waitReady
        },
        keyboard: { press: async () => assert.fail('passive idle must not issue keyboard input when no menu is open') }
      }
      const completion = idle(page).then(() => {
        finished = true
      })
      await Promise.race([waitEntered, completion])
      assert.equal(finished, false, 'true disabled must keep actual idle pending')
      assert.deepEqual(state.samples, [false])
      assert.deepEqual(state.clicks, [])
      assert.equal(sample(), false, 'busy must remain pending on a second public observation')
      if (compact) {
        state.present = false
        state.busy = false
        assert.equal(sample(), false, 'missing top selector must not be interpreted as idle')
        assert.equal(finished, false)
        state.present = true
      } else state.busy = false
      assert.equal(sample(), true)
      await completion
      assert.equal(finished, true)
      assert.equal(state.waits, 1)
      assert.deepEqual(state.clicks, [])
      assert.deepEqual([...new Set(state.queries)], [compact ? '[data-bp-select="blueprint"]' : '[data-bp-action="refresh-library"]'])
    })
  }
