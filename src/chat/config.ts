/**
 * Chat configuration, read fresh each time.
 *
 * The key is looked up per call rather than captured at import, so a server
 * started without one does not have to restart to pick it up in a test.
 */
export interface ChatConfig {
  apiKey: string | undefined;
  model: string;
  maxSteps: number;
  thinking: boolean;
}

export function chatConfig(): ChatConfig {
  const steps = Number.parseInt(process.env.APALEO_CHAT_MAX_STEPS ?? '', 10);
  return {
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    model: process.env.APALEO_CHAT_MODEL ?? 'claude-opus-5',
    maxSteps: Number.isFinite(steps) && steps > 0 ? steps : 12,
    // Adaptive thinking helps on the multi-step questions this chat is for.
    // Set APALEO_CHAT_THINKING=0 for the lowest latency on simple lookups.
    thinking: (process.env.APALEO_CHAT_THINKING ?? '1') !== '0',
  };
}
