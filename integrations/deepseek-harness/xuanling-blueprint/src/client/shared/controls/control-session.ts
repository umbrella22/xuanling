/** Pure, per-control interaction state. The browser supplies time and effective disabled state. */
export interface SelectOption {
  readonly value: string
  readonly text: string
  readonly disabled: boolean
}
export interface SelectContext {
  readonly options: readonly SelectOption[]
  readonly value: string
  readonly disabled: boolean
}
export interface SelectSessionState {
  readonly open: boolean
  readonly active: number
  readonly searchText: string
  readonly searchTime: number
}
export type SelectSessionIntent =
  | { type: 'open'; last?: boolean }
  | { type: 'close' }
  | { type: 'hover'; index: number }
  | { type: 'choose'; index: number }
  | { type: 'key'; key: string; now: number; composing?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
export interface SelectTransition {
  state: SelectSessionState
  chosen?: string
  preventDefault: boolean
  stopPropagation: boolean
  focusTrigger: boolean
}
export const initialSelectState = (): SelectSessionState => ({ open: false, active: -1, searchText: '', searchTime: 0 })
export function activeSelectIndex(state: SelectSessionState, context: SelectContext): number {
  return context.options[state.active] && !context.options[state.active]!.disabled ? state.active : context.options.findIndex(option => !option.disabled)
}
export function transitionSelect(state: SelectSessionState, context: SelectContext, intent: SelectSessionIntent): SelectTransition {
  const { options, value, disabled } = context
  const selected = options.findIndex(option => option.value === value)
  let next = state
  const result: SelectTransition = { state, preventDefault: false, stopPropagation: false, focusTrigger: false }
  const close = () => {
    next = { ...next, open: false }
  }
  const show = (last = false) => {
    if (disabled || !options.some(option => !option.disabled)) return
    next = {
      ...next,
      open: true,
      searchText: '',
      searchTime: 0,
      active:
        selected >= 0 && !options[selected]!.disabled
          ? selected
          : last
            ? options.findLastIndex(option => !option.disabled)
            : options.findIndex(option => !option.disabled)
    }
  }
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled || disabled) return
    close()
    if (option.value !== value) result.chosen = option.value
    result.focusTrigger = true
  }
  if (intent.type === 'close') close()
  else if (intent.type === 'open') show(intent.last)
  else if (intent.type === 'hover') {
    if (options[intent.index] && !options[intent.index]!.disabled) next = { ...next, active: intent.index }
  } else if (intent.type === 'choose') choose(intent.index)
  else {
    const { key } = intent
    result.stopPropagation = key !== 'Tab' && (key !== 'Escape' || state.open)
    if (intent.composing) return result
    if (!options.length || disabled) close()
    else if (key === 'Tab') close()
    else if (key === 'Escape') {
      if (state.open) {
        result.preventDefault = true
        close()
      }
    } else if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      result.preventDefault = true
      if (!state.open) {
        show(key === 'ArrowUp' || key === 'End')
        if (key === 'Home' || key === 'End')
          next = { ...next, active: key === 'Home' ? options.findIndex(option => !option.disabled) : options.findLastIndex(option => !option.disabled) }
      } else if (key === 'Enter' || key === ' ') choose(activeSelectIndex(state, context))
      else if (key === 'Home' || key === 'End')
        next = { ...next, active: key === 'Home' ? options.findIndex(option => !option.disabled) : options.findLastIndex(option => !option.disabled) }
      else {
        const direction = key === 'ArrowDown' ? 1 : -1
        for (let offset = 1; offset <= options.length; offset++) {
          const index = (activeSelectIndex(state, context) + direction * offset + options.length) % options.length
          if (!options[index]!.disabled) {
            next = { ...next, active: index }
            break
          }
        }
      }
    } else if (key.length === 1 && !intent.ctrlKey && !intent.metaKey && !intent.altKey) {
      result.preventDefault = true
      const text = intent.now - state.searchTime < 700 ? state.searchText + key.toLocaleLowerCase() : key.toLocaleLowerCase()
      if (!state.open) show()
      next = { ...next, searchText: text, searchTime: intent.now }
      const needle = [...text].every(char => char === text[0]) ? text[0]! : text
      for (let offset = text.length > 1 && needle.length > 1 ? 0 : 1; offset <= options.length; offset++) {
        const index = ((state.open ? activeSelectIndex(state, context) : selected) + offset + options.length) % options.length
        if (!options[index]!.disabled && options[index]!.text.toLocaleLowerCase().startsWith(needle)) {
          next = { ...next, active: index }
          break
        }
      }
    }
  }
  result.state = next
  return result
}
