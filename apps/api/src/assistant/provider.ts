import Anthropic from '@anthropic-ai/sdk';

/**
 * Management assistant providers (A-052). The provider only sees what the scoped report tools return (aggregates);
 * it never queries the database itself.
 */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export interface AskInput {
  system: string;
  /** Earlier turns of this conversation (text only) and the new question last. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ToolSpec[];
  runTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  maxRounds: number;
}

export interface AskResult {
  status: 'ANSWERED' | 'REFUSED';
  text: string;
  toolsUsed: Array<{ name: string; input: Record<string, unknown> }>;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
}

export abstract class AssistantProvider {
  abstract readonly name: string;
  abstract ask(input: AskInput): Promise<AskResult>;
}

export const ASSISTANT_MODEL = 'claude-opus-5-5';

/** The part of the Anthropic client the provider uses (replaced by a fake in unit tests). */
export interface MessagesClient {
  beta: {
    messages: {
      create(
        body: Anthropic.Beta.MessageCreateParamsNonStreaming,
      ): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

const toolResultText = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Claude through the official SDK: a manual tool loop with a hard round limit and token accounting. */
export class AnthropicAssistantProvider extends AssistantProvider {
  readonly name = 'anthropic';
  constructor(private readonly client: MessagesClient) {
    super();
  }

  async ask(input: AskInput): Promise<AskResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = input.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const tools: Anthropic.Beta.BetaTool[] = input.tools.map((t) => ({ ...t, strict: true }));
    const used: AskResult['toolsUsed'] = [];
    let inTok = 0;
    let outTok = 0;
    let model: string | null = null;
    for (let round = 0; round < input.maxRounds; round++) {
      const last = round === input.maxRounds - 1;
      const res = await this.client.beta.messages.create({
        model: ASSISTANT_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        // The instructions and tool list never change: cache them.
        system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
        // On the last round no more tools: the model must answer with what it has.
        ...(tools.length
          ? { tools, ...(last ? { tool_choice: { type: 'none' as const } } : {}) }
          : {}),
        messages,
      });
      inTok +=
        res.usage.input_tokens +
        (res.usage.cache_read_input_tokens ?? 0) +
        (res.usage.cache_creation_input_tokens ?? 0);
      outTok += res.usage.output_tokens;
      model = res.model;
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (res.stop_reason === 'refusal')
        return {
          status: 'REFUSED',
          text: 'The assistant cannot answer this question.',
          toolsUsed: used,
          inputTokens: inTok,
          outputTokens: outTok,
          model,
        };
      // Pass the whole content back unchanged (thinking blocks included).
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      if (res.stop_reason !== 'tool_use')
        return {
          status: 'ANSWERED',
          text: text || 'No answer.',
          toolsUsed: used,
          inputTokens: inTok,
          outputTokens: outTok,
          model,
        };
      const calls = res.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
        calls.map(async (c) => {
          const args = (c.input ?? {}) as Record<string, unknown>;
          used.push({ name: c.name, input: args });
          try {
            return {
              type: 'tool_result' as const,
              tool_use_id: c.id,
              content: toolResultText(await input.runTool(c.name, args)),
            };
          } catch (e) {
            return {
              type: 'tool_result' as const,
              tool_use_id: c.id,
              is_error: true,
              content: e instanceof Error ? e.message : 'Tool failed',
            };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    return {
      status: 'ANSWERED',
      text: 'The question needed more steps than allowed. Please ask something narrower.',
      toolsUsed: used,
      inputTokens: inTok,
      outputTokens: outTok,
      model,
    };
  }
}

/**
 * SANDBOX — development and tests only, never in production. Answers deterministically from the insights tool so the
 * whole flow (scope, limits, audit, UI) can be tested without an AI provider.
 */
export class SandboxAssistantProvider extends AssistantProvider {
  readonly name = 'sandbox';
  async ask(input: AskInput): Promise<AskResult> {
    const q = input.messages[input.messages.length - 1]?.content ?? '';
    if (!input.tools.length)
      return {
        status: 'ANSWERED',
        text: '[SANDBOX] Weekly brief: this text is written by the AI provider in production, from the figures above.',
        toolsUsed: [],
        inputTokens: 0,
        outputTokens: 0,
        model: 'sandbox',
      };
    const call = {
      name: 'get_insights',
      input: { from: null, to: null, brandId: null, teamId: null } as Record<string, unknown>,
    };
    const r = (await input.runTool(call.name, call.input)) as {
      period: { from: string; to: string };
      insights: Array<{ severity: string; title: string }>;
      headline: Record<string, unknown>;
    };
    const lines = r.insights.slice(0, 5).map((i) => `- [${i.severity}] ${i.title}`);
    const text = [
      `[SANDBOX] Answer to: "${q.slice(0, 200)}"`,
      `Period ${r.period.from} to ${r.period.to}: ${r.headline.leadsCreated} new leads, ${r.headline.admissions} admissions.`,
      lines.length ? `Insights:\n${lines.join('\n')}` : 'No insights need attention.',
    ].join('\n');
    return {
      status: 'ANSWERED',
      text,
      toolsUsed: [call],
      inputTokens: 0,
      outputTokens: 0,
      model: 'sandbox',
    };
  }
}

/**
 * Production uses Claude when ANTHROPIC_API_KEY is set, otherwise the assistant is "not configured" (null).
 * Other environments use the sandbox, unless ASSISTANT_PROVIDER=anthropic and a key are set (developer testing).
 */
export function buildAssistantProvider(
  nodeEnv: string,
  apiKey: string | undefined,
  choice: string | undefined,
): AssistantProvider | null {
  if (nodeEnv === 'production')
    return apiKey ? new AnthropicAssistantProvider(new Anthropic({ apiKey })) : null;
  if (choice === 'anthropic' && apiKey)
    return new AnthropicAssistantProvider(new Anthropic({ apiKey }));
  return new SandboxAssistantProvider();
}
