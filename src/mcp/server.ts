import '../env.js';
import { stdin, stdout } from 'node:process';
import { baseToolDescriptors } from '../tool-registry.js';
import { textFromToolResult, type RuntimeTool } from '../tool-runtime.js';
import { toolInputJsonSchema } from './schema.js';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

const toolsByName = new Map(baseToolDescriptors.map((tool) => [tool.name, tool]));
const allowMutations = process.env.MCP_ALLOW_MUTATIONS === '1';

function isMutating(tool: RuntimeTool): boolean {
  return !tool.annotations?.readOnlyHint;
}

function encodeMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

function send(payload: unknown): void {
  stdout.write(encodeMessage(payload));
}

function result(id: JsonRpcId | undefined, value: unknown): void {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  if (req.method === 'initialize') {
    result(req.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'rtd2-media-tools', version: process.env.npm_package_version ?? '0.1.0' },
    });
    return;
  }

  if (req.method === 'notifications/initialized') return;

  if (req.method === 'tools/list') {
    result(req.id, {
      tools: baseToolDescriptors.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toolInputJsonSchema(tool.inputSchema),
        annotations: {
          readOnlyHint: !!tool.annotations?.readOnlyHint,
          destructiveHint: isMutating(tool),
        },
      })),
    });
    return;
  }

  if (req.method === 'tools/call') {
    const params = req.params as { name?: string; arguments?: unknown } | undefined;
    const name = params?.name;
    if (!name) {
      error(req.id, -32602, 'tools/call requires params.name');
      return;
    }
    const tool = toolsByName.get(name);
    if (!tool) {
      error(req.id, -32602, `Unknown tool: ${name}`);
      return;
    }
    if (isMutating(tool) && !allowMutations) {
      result(req.id, {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `${name} is mutating and MCP_ALLOW_MUTATIONS is not set. ` +
              'Use the CLI confirmation gate or restart the MCP server with MCP_ALLOW_MUTATIONS=1.',
          },
        ],
      });
      return;
    }
    try {
      const output = await tool.handler(params?.arguments ?? {});
      result(req.id, { content: [{ type: 'text', text: textFromToolResult(output) }] });
    } catch (e) {
      result(req.id, {
        isError: true,
        content: [{ type: 'text', text: (e as Error).message }],
      });
    }
    return;
  }

  error(req.id, -32601, `Method not found: ${req.method}`);
}

let buffer = Buffer.alloc(0);

function readMessage(): Buffer | null {
  const sep = buffer.indexOf('\r\n\r\n');
  if (sep === -1) return null;
  const header = buffer.subarray(0, sep).toString('utf8');
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error('Missing Content-Length header');
  const length = Number(match[1]);
  const start = sep + 4;
  const end = start + length;
  if (buffer.length < end) return null;
  const body = buffer.subarray(start, end);
  buffer = buffer.subarray(end);
  return body;
}

stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  try {
    for (;;) {
      const body = readMessage();
      if (!body) break;
      const request = JSON.parse(body.toString('utf8')) as JsonRpcRequest;
      void handleRequest(request);
    }
  } catch (e) {
    error(null, -32700, (e as Error).message);
  }
});
