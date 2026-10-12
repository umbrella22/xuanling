// Hand-written typert host artifact (the generator is workspace-coupled for
// external packages — see plan U02). The dsh-typert-loader validates strict
// codecs as create() factories and registers TYPERT into ctx.typert when the
// mounted package exports ./typert.
import { z } from 'zod'

export const TYPERT = {
  package: '@xuanling-rs/blueprint-probe',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@xuanling-rs/blueprint-probe#blueprintProbe/echo',
      service: 'blueprintProbe',
      namespace: 'blueprintProbe',
      method: 'echo',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'message',
          wire: 'message',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@xuanling-rs/blueprint-probe/types#EchoMessage',
            create: () => z.string(),
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@xuanling-rs/blueprint-probe/types#EchoResult',
        create: () => z.object({ message: z.string(), pid: z.number(), startedAt: z.number() }),
      },
    },
  ],
  model: { services: [], events: [], objects: [] },
}
