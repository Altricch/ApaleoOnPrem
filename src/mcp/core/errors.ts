import type { ApiResponse } from './dispatch';

/**
 * Turning API failures into something a model can act on.
 *
 * MCP distinguishes protocol errors (the model cannot fix them) from tool
 * execution errors (it can). Everything here is the second kind: the message
 * says what was wrong and what to do instead, because that text is the only
 * thing the model gets to reason about before retrying.
 */
export class ToolError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface FailureContext {
  /** What was being acted on, e.g. `reservation 'ABC-1'`. */
  subject?: string;
  /** Tool to reach for when the subject was not found. */
  discoverWith?: string;
}

/**
 * The API restates the subject in its own message ("Reservation 'X' was not
 * found"), which stutters once the subject has already been named. Keep the
 * detail only when it says something the subject line did not.
 */
const addsInformation = (detail: string | undefined, subject: string | undefined): boolean => {
  if (!detail) return false;
  if (!subject) return true;
  const id = /'([^']+)'/.exec(subject)?.[1];
  return !(id && detail.includes(id));
};

const listMessages = (body: unknown): string[] => {
  const messages = (body as { messages?: unknown })?.messages;
  return Array.isArray(messages) ? messages.map(String) : [];
};

/** Throw a `ToolError` whose text tells the model how to recover. */
export function raiseFor(response: ApiResponse, context: FailureContext = {}): never {
  const messages = listMessages(response.body);
  const detail = messages.length ? messages.join(' ') : undefined;
  const subject = context.subject ? `${context.subject}: ` : '';

  switch (response.status) {
    case 400:
    case 422:
      throw new ToolError(
        `${subject}the request was rejected. ${detail ?? 'The input did not pass validation.'}`
        + ' Correct the arguments and call again.',
        response.status,
      );
    case 401:
      throw new ToolError(
        'Not authenticated. Set APALEO_TOKEN, or run the server with APALEO_ALLOW_ANONYMOUS=true for local use.',
        401,
      );
    case 403:
      throw new ToolError(
        `${subject}the credential lacks the scope this operation needs. ${detail ?? ''}`.trim(),
        403,
      );
    case 404: {
      const extra = addsInformation(detail, context.subject) ? detail : undefined;
      throw new ToolError(
        `${subject}not found.${extra ? ` ${extra}` : ''}`
        + (context.discoverWith ? ` Use ${context.discoverWith} to find valid ids.` : ''),
        404,
      );
    }
    case 409:
      throw new ToolError(
        `${subject}conflicts with the current state. ${detail ?? ''}`.trim()
        + ' Re-read the entity before retrying.',
        409,
      );
    case 501:
      throw new ToolError(detail ?? 'That operation is not implemented.', 501);
    default: {
      const extra = addsInformation(detail, context.subject) ? detail : undefined;
      throw new ToolError(
        `${subject}the API returned ${response.status}.${extra ? ` ${extra}` : ''}`,
        response.status,
      );
    }
  }
}

/** True when the response carries a usable payload. */
export function ok(response: ApiResponse): boolean {
  return response.status >= 200 && response.status < 300;
}
