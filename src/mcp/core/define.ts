import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ToolError } from './errors';

/**
 * Tool definitions.
 *
 * Description quality is the single biggest lever on whether a model picks
 * the right tool, so the shape of a description is enforced here rather than
 * left to prose: every tool states what it does, when to reach for it, what
 * to use *instead* when it is the wrong choice, and what comes back. Writing
 * `use`/`avoid` is mandatory, which means no tool can quietly ship with a
 * one-line description that reads like three of its neighbours.
 */

export interface ToolDoc {
  /** One sentence, imperative: "Search reservations by date, status or guest." */
  summary: string;
  /** Concrete situations this tool is the right answer to. */
  use: string[];
  /** Situations it is the wrong answer to, naming the tool that is right. */
  avoid: string[];
  /** What the caller gets back. One line. */
  returns: string;
  /** Semantics that are easy to get wrong. Optional but usually worth it. */
  notes?: string[];
}

export interface ToolResult {
  /** Compact text for the model. This is what it actually reads. */
  text: string;
  /** Machine-readable payload mirrored into `structuredContent`. */
  data?: unknown;
}

/** The shape passed to `registerTool`: a plain map of argument name to schema. */
export type Shape = Record<string, z.ZodTypeAny>;

/** Arguments as the handler receives them, after zod has parsed defaults. */
export type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

export type Handler<S extends Shape> = (args: Args<S>) => Promise<ToolResult>;

export interface ToolSpec<S extends Shape> {
  name: string;
  title: string;
  doc: ToolDoc;
  input: Shape;
  /**
   * Behaviour hints.
   *
   * `readOnly` lets a client run the tool without prompting, so anything that
   * changes money, inventory or guest state must not claim it.
   *
   * `destructive` and `requiresConfirmation` are deliberately separate.
   * Destructive is the MCP hint: the tool overwrites or removes something
   * rather than only adding. Requiring confirmation is a stronger, local
   * claim: the effect cannot be undone by calling another tool, so a human
   * has to agree first. Undoing a check-in is destructive but recoverable;
   * cancelling a reservation is both.
   */
  annotations: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    requiresConfirmation?: boolean;
  };
  handler: Handler<S>;
}

/** Render a `ToolDoc` into the description string the model sees. */
export function describe(doc: ToolDoc): string {
  const lines = [doc.summary, ''];
  lines.push('USE WHEN', ...doc.use.map((x) => `· ${x}`), '');
  lines.push('DO NOT USE FOR', ...doc.avoid.map((x) => `· ${x}`), '');
  lines.push(`RETURNS: ${doc.returns}`);
  if (doc.notes?.length) {
    lines.push('', 'NOTES', ...doc.notes.map((x) => `· ${x}`));
  }
  return lines.join('\n');
}

function toAnnotations(spec: ToolSpec<Shape>): ToolAnnotations {
  const { readOnly = false, destructive = false, idempotent = false } = spec.annotations;
  return {
    title: spec.title,
    readOnlyHint: readOnly,
    // The hint is only meaningful on a writing tool; the spec says it is
    // ignored when readOnlyHint is true.
    ...(readOnly ? {} : { destructiveHint: destructive, idempotentHint: idempotent }),
    // Everything here talks to one local database, never the open internet.
    openWorldHint: false,
  };
}

/** Register one tool on a server, with uniform error and result handling. */
export function register<S extends Shape>(server: McpServer, spec: ToolSpec<S>): void {
  // Enforced at registration, not review time: a tool that claims to need
  // confirmation but offers no way to give it would refuse forever.
  if (spec.annotations.requiresConfirmation && !('confirm' in spec.input)) {
    throw new Error(
      `Tool '${spec.name}' sets requiresConfirmation but has no \`confirm\` argument. `
      + 'Add `confirm: arg.confirm` to its input.',
    );
  }
  if (!spec.annotations.requiresConfirmation && 'confirm' in spec.input) {
    throw new Error(
      `Tool '${spec.name}' takes a \`confirm\` argument but does not set `
      + 'requiresConfirmation, so nothing enforces it.',
    );
  }

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: describe(spec.doc),
      inputSchema: spec.input,
      annotations: toAnnotations(spec as unknown as ToolSpec<Shape>),
      ...(spec.annotations.requiresConfirmation
        // Surfaced so a host can prompt the user itself rather than waiting
        // for the tool to refuse a first attempt.
        ? { _meta: { 'io.apaleo/requiresConfirmation': true } }
        : {}),
    },
    (async (args: never) => {
      try {
        const result = await spec.handler(args);
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.data === undefined ? {} : { structuredContent: asStructured(result.data) }),
        };
      } catch (err) {
        // Anything reaching here is reported to the model, not thrown at the
        // protocol layer, so it can correct itself and retry.
        const message = err instanceof ToolError
          ? err.message
          : `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }) as never,
  );
}

/**
 * `structuredContent` must be a JSON object in most clients, so bare arrays
 * and scalars are wrapped rather than dropped.
 */
function asStructured(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return { result: data };
}

/* ------------------------------------------------------- shared arguments */

/**
 * Argument fragments reused across domains. Defining them once keeps the
 * wording identical everywhere, which matters: a model that has learned what
 * `propertyId` means on one tool should not have to relearn it on the next.
 */
export const arg = {
  propertyId: z.string().describe(
    'Property id, e.g. "MUC". Omit to use the only property when there is just one; '
    + 'otherwise required. List them with apaleo_list_properties.',
  ),
  optionalPropertyId: z.string().optional().describe(
    'Property id, e.g. "MUC". Defaults to the single configured property, or the one '
    + 'implied by another argument. Required when the account has several.',
  ),
  reservationId: z.string().describe('Reservation id, e.g. "XPGMSXGF-1".'),
  folioId: z.string().describe('Folio id, e.g. "XPGMSXGF-1-1".'),
  date: (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').describe(what),
  optionalDate: (what: string) =>
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional().describe(what),
  limit: (fallback: number, max: number) => z.number().int().min(1).max(max).default(fallback)
    .describe(`Maximum rows to return (1-${max}). Keep it small; raise it only when the answer needs more.`),
  detail: z.enum(['summary', 'full']).default('summary').describe(
    'summary returns the fields needed to answer most questions; full adds every nested '
    + 'collection. Prefer summary - full is considerably longer.',
  ),
  confirm: z.boolean().default(false).describe(
    'Must be true to proceed. This operation changes money or guest state and cannot be '
    + 'undone by calling the same tool again.',
  ),
};

/** Guard a destructive tool behind an explicit confirmation. */
export function requireConfirmation(confirm: boolean, what: string): void {
  if (!confirm) {
    throw new ToolError(
      `Not performed. ${what} Call again with confirm=true once the user has agreed.`,
    );
  }
}
