// Client half of the W0.2 probe: the official closure-factory format.
// React comes from the platform seed table (singleton proof: no react bytes in
// this package). Registers one sidebar panel entry.
window.__ModuleLoader__.load({
  id: '@xuanling-rs/blueprint-probe',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function ProbePanel() {
      return h('div', {
        'data-blueprint-probe': 'panel',
        style: { padding: '12px', fontSize: '13px' },
      },
      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Blueprint Probe'),
      h('div', { style: { opacity: 0.7 } }, 'W0.2 capability probe panel is live.'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'blueprint-probe-panel',
          order: 90,
          label: () => 'Blueprint Probe',
        }, ProbePanel))
      },
    }
  },
})
