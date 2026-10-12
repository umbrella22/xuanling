// The isolated probe is keyless. DSH acknowledges Preview Notice asynchronously
// before loading its API-key step, so a transient empty DOM is not completion.
// These titles/actions are the public Modal markup and ui-settings-models copy;
// unrelated dialogs remain gate failures, not permission to bypass a mask.
const visibleDialogsSelector = '[role="dialog"]:visible'
const interactionTimeout = 3000 // Keep the original probe's per-action bound.
const steps = new Map([
  ['Preview Notice', { kind: 'preview', action: 'Continue' }],
  ['预览版说明', { kind: 'preview', action: '继续' }],
  ['Add an API key to get started', { kind: 'keyless', action: 'Configure later' }],
  ['添加一个 API Key 开始使用', { kind: 'keyless', action: '稍后配置' }],
])

export async function dismissOnboardingDialogs(page) {
  const visibleDialogs = page.locator(visibleDialogsSelector)
  const dismissed = new Set()
  while (true) {
    const count = await visibleDialogs.count()
    if (count === 0) return
    if (count !== 1) throw new Error('onboarding blocked by multiple visible dialogs')
    const title = await visibleDialogs.first().getAttribute('aria-label')
    const step = steps.get(title)
    if (!step) throw new Error('onboarding blocked by an unrecognized visible dialog')
    if (dismissed.has(step.kind)) throw new Error('onboarding repeated an already-dismissed step')

    // Scope by the exact dialog title, never a global body button. Playwright
    // performs its ordinary visibility/actionability/hit-testing here.
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await dialog.getByRole('button', { name: step.action, exact: true }).click({ timeout: interactionTimeout })
    // The title-bound locator cannot retarget the next dialog while waiting for
    // this one's asynchronous acknowledgement/skip to actually settle.
    await dialog.waitFor({ state: 'hidden', timeout: interactionTimeout })
    dismissed.add(step.kind)
    if (step.kind === 'preview') {
      // The probe's fresh keyless profile must reach its next visible modal,
      // even when the models loader creates a no-dialog interval in between.
      await visibleDialogs.first().waitFor({ state: 'visible', timeout: interactionTimeout })
    } else {
      if (await visibleDialogs.count() !== 0) throw new Error('a visible dialog remains after keyless onboarding')
      return
    }
  }
}
