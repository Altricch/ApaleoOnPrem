/**
 * The bridge between the chat agent and the MCP surface.
 *
 * The agent does not import the domain layer, and it does not import the MCP
 * tool modules either. It speaks to a real MCP client over the in-memory
 * transport, exactly as Claude Desktop would over stdio. What the chat can do
 * is therefore precisely what any other MCP client can do - including the
 * confirmation gating, the rendered tables, and the actionable errors.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, DOMAIN_NAMES, type DomainName } from '../mcp/server';

/** Anthropic's tool shape. Declared here so the bridge owns the conversion. */
export interface ChatTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

export interface ToolFacts {
  /** Tools in the order the MCP server lists them, which is stable. */
  tools: ChatTool[];
  /** Names that refuse to act unless `confirm: true` is passed. */
  gated: Set<string>;
  /** Names that change nothing, for labelling in the transcript. */
  readOnly: Set<string>;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

const REQUIRES_CONFIRMATION = 'io.apaleo/requiresConfirmation';

/**
 * One client per process. Building the server registers 45 tools and opening
 * the transport is not free, so a chat turn should not pay for it: the first
 * request warms it and every later one reuses it.
 */
let connecting: Promise<Client> | null = null;

export function mcpClient(domains: readonly DomainName[] = DOMAIN_NAMES): Promise<Client> {
  if (!connecting) {
    connecting = (async () => {
      const server = buildServer({ domains });
      const client = new Client({ name: 'apaleo-chat', version: '1.0.0' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      return client;
    })().catch((err) => {
      // A failed connection must not be cached, or every later turn inherits it.
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

/** Drop the client so the next call rebuilds it. Used by tests. */
export async function resetBridge(): Promise<void> {
  const pending = connecting;
  connecting = null;
  if (pending) await (await pending).close().catch(() => undefined);
}

let facts: ToolFacts | null = null;

/**
 * The tool list, converted once. MCP input schemas are already JSON Schema, so
 * the conversion is a rename rather than a translation - which is the point of
 * building the chat on MCP instead of on the HTTP API.
 */
export async function toolFacts(): Promise<ToolFacts> {
  if (facts) return facts;
  const client = await mcpClient();
  const { tools } = await client.listTools();

  const gated = new Set<string>();
  const readOnly = new Set<string>();
  const converted: ChatTool[] = [];

  for (const tool of tools) {
    if (tool._meta?.[REQUIRES_CONFIRMATION] === true) gated.add(tool.name);
    if (tool.annotations?.readOnlyHint === true) readOnly.add(tool.name);
    converted.push({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema as ChatTool['input_schema'],
    });
  }

  facts = { tools: converted, gated, readOnly };
  return facts;
}

/**
 * Run one tool and flatten its reply to text.
 *
 * A tool that reports `isError` is not an exception: the message was written
 * to tell the model how to recover, so it goes back as a tool result and the
 * conversation continues.
 */
export async function runTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const client = await mcpClient();
  try {
    const result = await client.callTool({ name, arguments: input });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    return { text: text || '(the tool returned no text)', isError: result.isError === true };
  } catch (err) {
    // A throw here is a protocol or validation failure - unknown tool, bad
    // argument shape. The model can still fix those, so report rather than
    // abort the turn.
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}
