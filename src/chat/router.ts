/**
 * HTTP surface for the chat.
 *
 *   GET  /chat/v1/status   is a model reachable, and what can it do
 *   POST /chat/v1/turn     run one exchange, streamed as server-sent events
 *
 * These sit outside the apaleo namespace deliberately: they are part of this
 * clone's console, not of the API being cloned.
 */
import { Router, type Request, type Response } from 'express';
import { runTurn, type ChatEvent, type Decision } from './agent';
import { toolFacts } from './bridge';
import { chatConfig } from './config';
import { DOMAINS, DOMAIN_NAMES } from '../mcp/server';

export function chatRouter(): Router {
  const router = Router();

  router.get('/chat/v1/status', async (_req, res) => {
    const { apiKey, model, thinking } = chatConfig();
    try {
      const { tools, gated, readOnly } = await toolFacts();
      res.json({
        enabled: Boolean(apiKey),
        model,
        thinking,
        tools: tools.length,
        gated: [...gated].sort(),
        readOnly: readOnly.size,
        domains: DOMAIN_NAMES.map((name) => ({
          name,
          title: DOMAINS[name].title,
          blurb: DOMAINS[name].blurb,
        })),
      });
    } catch (err) {
      res.status(500).json({ enabled: false, message: err instanceof Error ? err.message : 'failed' });
    }
  });

  router.post('/chat/v1/turn', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ message: 'messages must be a non-empty array' });
      return;
    }

    // Server-sent events. Flushing the headers immediately matters: without it
    // a proxy can hold the response until the first tool finishes, and the
    // user watches a dead screen.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const emit = (event: ChatEvent): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runTurn(
        {
          messages: body.messages,
          decisions: (body.decisions ?? {}) as Record<string, Decision>,
          propertyId: typeof body.propertyId === 'string' ? body.propertyId : undefined,
        },
        emit,
        controller.signal,
      );
    } catch (err) {
      // Never let an API failure surface as a dead stream; the UI has no way
      // to tell that apart from a hung request.
      emit({ type: 'error', message: readableError(err) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}

/** Turn an SDK or network failure into something worth showing a user. */
function readableError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const status = (err as { status?: number }).status;
  if (status === 401) return 'The Anthropic API rejected the key. Check ANTHROPIC_API_KEY.';
  if (status === 429) return 'Rate limited by the Anthropic API. Wait a moment and try again.';
  if (status === 529) return 'The Anthropic API is overloaded. Try again shortly.';
  if (err.message.includes('ENOTFOUND') || err.message.includes('fetch failed')) {
    return 'Could not reach the Anthropic API. Check this machine has network access.';
  }
  return err.message;
}
