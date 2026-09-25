#!/usr/bin/env node
/**
 * smoke-test.mjs — sanity check against a running server.
 * Assumes the server is already up on localhost:8899 (or $BASE_URL).
 * Sends an MCP initialize + tools/list over stateless HTTP.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8899';
const KEY = process.env.MCP_AUTH_KEY || '';

const headers = {
  'content-type': 'application/json',
  // Stateless streamable HTTP requires both media types.
  accept: 'application/json, text/event-stream',
};
if (KEY) headers.authorization = `Bearer ${KEY}`;

async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  // SSE framing: strip the `data: ` prefix when present.
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  return body;
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  console.log('initialize:', init.result?.serverInfo ?? init.error);

  const list = await rpc('tools/list', {});
  const tools = list.result?.tools?.map((t) => t.name) ?? [];
  console.log('tools:', tools.join(', '));

  console.log('\n✓ Server responded. Connect it to your MCP client now.');
  process.exit(list.result?.tools ? 0 : 1);
} catch (e) {
  console.error('✗ smoke test failed:', e.message);
  process.exit(1);
}
