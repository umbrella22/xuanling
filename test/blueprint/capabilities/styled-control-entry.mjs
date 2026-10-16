/** Exercise the actual themed combobox/listbox, preserving exact raw option IDs. */
export async function selectStyledOption(page, control, value, { confirm = true } = {}) {
  await control.click()
  const listId = await control.getAttribute('aria-controls')
  const option = page.locator(`[id=${JSON.stringify(listId)}] [role="option"][data-bp-option-value=${JSON.stringify(value)}]`)
  if (await option.getAttribute('aria-disabled') === 'true') throw new Error(`disabled Blueprint option: ${value}`)
  await option.click()
  const dialog = page.locator('[data-bp-confirm-dialog]')
  if (await dialog.count()) await dialog.locator(confirm ? '[data-bp-confirm-accept]' : '[data-bp-confirm-cancel]').click()
}
export async function styledSelectValue(control) { return control.getAttribute('data-bp-value') }
