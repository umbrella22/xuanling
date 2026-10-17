import type { AttemptDiagnosticsViewModel } from './diagnostics-model.ts'

export function AttemptDiagnosticsView({ model }: { model: AttemptDiagnosticsViewModel }) {
  return (
    <section data-bp-diagnostics={model.status}>
      <h4>{model.title}</h4>
      {model.status === 'unavailable' ? (
        <p>{model.message}</p>
      ) : (
        model.rows.map(row => (
          <div key={row.key} data-bp-diagnostic={row.key}>
            <strong>{row.label}</strong>
            {row.values.map((text, index) => (
              <p key={index}>{text}</p>
            ))}
          </div>
        ))
      )}
    </section>
  )
}
