import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicAssistantProvider, ASSISTANT_MODEL, type MessagesClient } from './provider';

type Res = Partial<Anthropic.Beta.BetaMessage> &
  Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason'>;
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 50,
  cache_creation_input_tokens: 0,
};
function fake(responses: Res[]) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    beta: {
      messages: {
        create: async (body) => {
          calls.push(structuredClone(body));
          const r = responses.shift()!;
          return { model: ASSISTANT_MODEL, usage, ...r } as Anthropic.Beta.BetaMessage;
        },
      },
    },
  };
  return { client, calls };
}
const tool = {
  name: 'get_summary',
  description: 'd',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  },
};

describe('Claude assistant tool loop (A-052)', () => {
  it('runs the requested tools as the user and answers from their results', async () => {
    const { client, calls } = fake([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'get_summary',
            input: { from: '2026-11-01' },
          } as Anthropic.Beta.BetaToolUseBlock,
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Admissions are 12.' } as Anthropic.Beta.BetaTextBlock],
      },
    ]);
    const ran: unknown[] = [];
    const r = await new AnthropicAssistantProvider(client).ask({
      system: 'S',
      messages: [{ role: 'user', content: 'How many admissions?' }],
      tools: [tool],
      runTool: async (n, a) => (ran.push([n, a]), { admissions: 12n }),
      maxRounds: 8,
    });
    expect(r).toMatchObject({
      status: 'ANSWERED',
      text: 'Admissions are 12.',
      toolsUsed: [{ name: 'get_summary' }],
      inputTokens: 300,
      outputTokens: 40,
    });
    expect(ran).toEqual([['get_summary', { from: '2026-11-01' }]]);
    // Request shape: model, refusal fallback, strict tools, cached system prompt; tool result fed back (bigint as text).
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'get_summary', strict: true }],
    });
    expect(calls[1].messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"admissions":"12"}' }],
    });
  });

  it('tool errors go back to the model; the last round allows no more tools', async () => {
    const { client, calls } = fake([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'get_summary',
            input: {},
          } as Anthropic.Beta.BetaToolUseBlock,
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: 'Could not read the figures.' } as Anthropic.Beta.BetaTextBlock,
        ],
      },
    ]);
    const r = await new AnthropicAssistantProvider(client).ask({
      system: 'S',
      messages: [{ role: 'user', content: 'q' }],
      tools: [tool],
      runTool: async () => {
        throw new Error('Brand not found');
      },
      maxRounds: 2,
    });
    expect(calls[1].messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Brand not found' },
    ]);
    expect(calls[0].tool_choice).toBeUndefined();
    expect(calls[1].tool_choice).toEqual({ type: 'none' });
    expect(r.text).toBe('Could not read the figures.');
  });

  it('reports a refusal', async () => {
    const { client } = fake([{ stop_reason: 'refusal', content: [] }]);
    const r = await new AnthropicAssistantProvider(client).ask({
      system: 'S',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      runTool: async () => null,
      maxRounds: 1,
    });
    expect(r.status).toBe('REFUSED');
  });
});
