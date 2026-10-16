import ReactSeat from 'react'
import type React from 'react'

/** Options keep their original values and labels; no domain normalization happens here. */
export interface StyledSelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'> {
  React?: typeof ReactSeat
  [attribute: `data-${string}`]: string | boolean | undefined
}
export function StyledSelect({ React = ReactSeat, children, value, disabled, onChange, className = '', ...attributes }: StyledSelectProps): React.ReactElement {
  const h = React.createElement
  const root = React.useRef<HTMLDivElement>(null)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const list = React.useRef<HTMLDivElement>(null)
  const [id] = React.useState(() => `bp-select-${crypto.randomUUID()}`)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const search = React.useRef({ text: '', time: 0 })
  const options: Array<{ value: string; label: React.ReactNode; text: string; disabled: boolean }> = []
  React.Children.forEach(children, child => {
    if (!React.isValidElement<React.OptionHTMLAttributes<HTMLOptionElement>>(child) || child.type !== 'option') return
    const props = child.props
    options.push({ value: String(props.value ?? ''), label: props.children, text: String(props.children ?? ''), disabled: !!props.disabled })
  })
  // An empty/all-disabled catalog cannot open: expose that state to users and
  // native button actionability while asynchronous options are still loading.
  const unavailable = disabled || !options.some(option => !option.disabled)
  const selected = options.findIndex(option => option.value === String(value ?? ''))
  const activeIndex = options[active] && !options[active]!.disabled ? active : options.findIndex(option => !option.disabled)
  const close = () => setOpen(false)
  const show = (last = false) => {
    if (disabled || trigger.current?.matches(':disabled') || !options.some(option => !option.disabled)) return
    search.current = { text: '', time: 0 }
    setActive(
      selected >= 0 && !options[selected]!.disabled
        ? selected
        : last
          ? options.findLastIndex(option => !option.disabled)
          : options.findIndex(option => !option.disabled)
    )
    setOpen(true)
  }
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled || disabled || trigger.current?.matches(':disabled')) return
    close()
    if (option.value !== String(value ?? '')) {
      const target = { value: option.value }
      onChange?.({ target, currentTarget: target } as React.ChangeEvent<HTMLSelectElement>)
    }
    trigger.current?.focus()
  }
  React.useEffect(() => {
    if (!open) return
    const element = list.current
    if (!element) return
    // The top layer escapes overflow/stacking contexts while retaining DOM ancestry,
    // theme inheritance, dialog containment and its focus trap. No second React root.
    element.showPopover?.()
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(Math.max(anchor.width, 220), window.innerWidth - 16)
      const below = window.innerHeight - anchor.bottom - 12,
        above = anchor.top - 12
      const up = below < Math.min(280, element.scrollHeight) && above > below
      Object.assign(element.style, {
        width: `${width}px`,
        left: `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`,
        top: up ? 'auto' : `${anchor.bottom + 4}px`,
        bottom: up ? `${window.innerHeight - anchor.top + 4}px` : 'auto',
        maxHeight: `${Math.max(40, Math.min(320, up ? above : below))}px`
      })
    }
    place()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close()
    }
    const disabledObserver = new MutationObserver(() => {
      if (trigger.current?.matches(':disabled')) close()
    })
    for (let ancestor: HTMLElement | null = trigger.current?.parentElement ?? null; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === 'FIELDSET') disabledObserver.observe(ancestor, { attributes: true, attributeFilter: ['disabled'] })
    }
    const observer = new ResizeObserver(place)
    if (trigger.current) observer.observe(trigger.current)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      element.hidePopover?.()
      observer.disconnect()
      disabledObserver.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  React.useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-bp-option-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])
  React.useEffect(() => {
    if (unavailable) close()
  }, [unavailable])
  const keyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Tab' && (event.key !== 'Escape' || open)) event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!options.length || disabled || trigger.current?.matches(':disabled')) {
      close()
      return
    }
    const key = event.key
    if (key === 'Tab') {
      close()
      return
    }
    if (key === 'Escape') {
      if (open) {
        event.preventDefault()
        close()
      }
      return
    }
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      event.preventDefault()
      if (!open) {
        show(key === 'ArrowUp' || key === 'End')
        if (key === 'Home' || key === 'End') setActive(key === 'Home' ? options.findIndex(o => !o.disabled) : options.findLastIndex(o => !o.disabled))
        return
      }
      if (key === 'Enter' || key === ' ') {
        choose(activeIndex)
        return
      }
      if (key === 'Home' || key === 'End') {
        setActive(key === 'Home' ? options.findIndex(o => !o.disabled) : options.findLastIndex(o => !o.disabled))
        return
      }
      const direction = key === 'ArrowDown' ? 1 : -1
      for (let offset = 1; offset <= options.length; offset++) {
        const index = (activeIndex + direction * offset + options.length) % options.length
        if (!options[index]!.disabled) {
          setActive(index)
          break
        }
      }
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = Date.now(),
        previous = search.current
      const text = now - previous.time < 700 ? previous.text + key.toLocaleLowerCase() : key.toLocaleLowerCase()
      if (!open) show()
      search.current = { text, time: now }
      const needle = [...text].every(char => char === text[0]) ? text[0]! : text
      for (let offset = text.length > 1 && needle.length > 1 ? 0 : 1; offset <= options.length; offset++) {
        const index = ((open ? activeIndex : selected) + offset + options.length) % options.length
        if (!options[index]!.disabled && options[index]!.text.toLocaleLowerCase().startsWith(needle)) {
          setActive(index)
          break
        }
      }
    }
  }
  const { onBlur: _onBlur, onFocus: _onFocus, onKeyDown: _onKeyDown, ...rest } = attributes
  return h(
    'div',
    {
      ref: root,
      className: `bp-select ${className}`,
      onBlur: (event: React.FocusEvent) => {
        if (!root.current?.contains(event.relatedTarget as Node)) close()
      }
    },
    h(
      'button',
      {
        ...rest,
        ref: trigger,
        type: 'button',
        role: 'combobox',
        disabled: unavailable,
        className: 'bp-select-trigger',
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-controls': id,
        'data-bp-value': String(value ?? ''),
        'aria-activedescendant': open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined,
        onKeyDown: keyDown,
        onClick: () => (open ? close() : show())
      },
      h('span', { className: 'bp-select-value' }, options[selected]?.label ?? ''),
      h('span', { className: 'bp-select-chevron', 'aria-hidden': true }, '⌄')
    ),
    open &&
      h(
        'div',
        {
          ref: list,
          id,
          role: 'listbox',
          popover: 'manual',
          className: 'bp-select-list',
          'aria-label': attributes['aria-label'],
          onPointerDown: (event: React.PointerEvent) => event.preventDefault(),
          onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation()
        },
        ...options.map((option, index) =>
          h(
            'div',
            {
              key: option.value,
              id: `${id}-${index}`,
              role: 'option',
              'aria-selected': index === selected,
              'aria-disabled': option.disabled,
              'data-bp-option-index': index,
              'data-bp-option-value': option.value,
              'data-bp-active': index === activeIndex,
              onPointerMove: () => {
                if (!option.disabled) setActive(index)
              },
              onClick: (event: React.MouseEvent) => {
                event.preventDefault()
                event.stopPropagation()
                choose(index)
              }
            },
            h('span', { className: 'bp-select-option-label' }, option.label),
            h('span', { 'aria-hidden': true, className: 'bp-select-check' }, index === selected ? '✓' : '')
          )
        )
      )
  )
}

export interface ConfirmationDialogProps {
  React: typeof ReactSeat
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}
export function ConfirmationDialog({ React, title, description, cancelLabel, confirmLabel, onCancel, onConfirm }: ConfirmationDialogProps): React.ReactElement {
  const h = React.createElement,
    ref = React.useRef<HTMLDivElement>(null)
  const [id] = React.useState(() => `bp-confirm-${crypto.randomUUID()}`)
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLButtonElement>('[data-bp-confirm-cancel]')?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return h(
    'div',
    {
      className: 'bp-confirm-backdrop',
      onPointerDown: (event: React.PointerEvent) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onCancel()
      }
    },
    h(
      'div',
      {
        ref,
        role: 'dialog',
        'aria-modal': true,
        'aria-labelledby': `${id}-title`,
        'aria-describedby': `${id}-description`,
        tabIndex: -1,
        className: 'bp-confirm-dialog',
        'data-bp-confirm-dialog': true,
        onKeyDown: (event: React.KeyboardEvent) => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
          if (event.key === 'Tab') {
            const controls = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
            const first = controls[0],
              last = controls.at(-1)
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }
      },
      h('h2', { id: `${id}-title` }, title),
      h('p', { id: `${id}-description` }, description),
      h(
        'div',
        { className: 'bp-confirm-actions' },
        h('button', { type: 'button', 'data-bp-confirm-cancel': true, onClick: onCancel }, cancelLabel),
        h('button', { type: 'button', 'data-bp-confirm-accept': true, onClick: onConfirm }, confirmLabel)
      )
    )
  )
}
