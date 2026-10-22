/** Closed vocabulary shared by the durable reducer and its delivery owner. */
export class ManagedNodeError extends Error {
  constructor(readonly code: 'node-not-active' | 'node-session-unavailable' | 'command-conflict' | 'node-message-unknown') {
    super(code)
  }
}
