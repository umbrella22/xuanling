/** Native Settings UI selection, usable before any plugin panel opens.
 * The caller must finish onboarding first. Ordinary Playwright clicks retain
 * visibility/actionability/hit-testing; any failed step rejects without bypass.
 */
export async function openNativeSettings(page) {
  await page.getByRole('button', { name: /^(账号菜单|Account menu)$/ }).click()
  await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click()
  const modal = page.locator('[data-shortcut-modal="settings"]')
  await modal.waitFor({ state: 'visible' })
  return modal
}

export async function setNativeSettingsLocale(page, id) {
  if (id !== 'en' && id !== 'zh') throw new Error('unsupported acceptance locale')
  const label = id === 'en' ? 'English' : '中文'
  const row = id === 'en' ? 'Language' : '语言'

  const modal = await openNativeSettings(page)
  // Always use the native menu, including when the target is already active.
  await modal.getByRole('button', { name: /^(中文|English)$/ }).click()
  // The Host menu is portalled outside the Settings modal.
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await modal.getByText(row, { exact: true }).waitFor({ state: 'visible' })
  await modal.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await modal.waitFor({ state: 'hidden' })
}
