#!/usr/bin/env node
// Controlled REAL MCP server for the W7.3 journey (plan §10.4 "MCP: 实际受控
// server 进程；只对 temp 数据做可计数副作用"). Official SDK, stdio transport,
// exactly one tool: `record_side_effect` appends one line to the file named by
// BP_MCP_SIDE_EFFECT_FILE (always under a temp dir the harness owns) and
// returns the resulting count. No other side effects exist.
import { appendFileSync, readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const sideEffectFile = process.env.BP_MCP_SIDE_EFFECT_FILE
if (sideEffectFile === undefined || sideEffectFile.length === 0) {
  process.stderr.write('bp-probe-mcp: BP_MCP_SIDE_EFFECT_FILE is required\n')
  process.exit(2)
}

const server = new Server(
  { name: 'bp-probe-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'record_side_effect',
      description: 'Append one line to the controlled side-effect file and return the new count.',
      inputSchema: {
        type: 'object',
        properties: { tag: { type: 'string', description: 'Line content to append.' } },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'record_side_effect') {
    return { content: [{ type: 'text', text: `unknown tool ${request.params.name}` }], isError: true }
  }
  const tag = typeof request.params.arguments?.tag === 'string' ? request.params.arguments.tag : 'default'
  appendFileSync(sideEffectFile, `${tag}\n`)
  const count = readFileSync(sideEffectFile, 'utf8').split('\n').filter(line => line.length > 0).length
  return { content: [{ type: 'text', text: JSON.stringify({ count, tag }) }] }
})

await server.connect(new StdioServerTransport())
