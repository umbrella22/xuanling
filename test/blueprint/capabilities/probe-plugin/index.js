// Host half of the W0.2 probe: one minimal typed Remote service built on the
// published public API only (@deepseek-ai/cordis Service + dsh-typert-protocol
// binding). The wire descriptors live in ./typert.host.js, which
// @deepseek-ai/dsh-typert-loader registers automatically for mounted packages
// exporting ./typert.
import { Service } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'

export class BlueprintProbe extends Service {
  static inject = []

  constructor(ctx, config) {
    super(ctx, 'blueprintProbe')
    this.typertRemote = bindTypertRemote(this, 'blueprintProbe', { namespace: 'blueprintProbe' })
    this.startedAt = Date.now()
  }

  async echo(message, _signal) {
    return { message: `probe-echo:${message}`, pid: process.pid, startedAt: this.startedAt }
  }
}

export default BlueprintProbe
