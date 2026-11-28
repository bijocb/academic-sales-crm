'use client';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  useAction,
  useLoad,
} from '@/components/ui';
import { InsightList, InsightsResponse } from '@/components/insights';
import { api } from '@/lib/api';
import type { Brand } from '@/lib/types';

interface AssistantStatus {
  enabled: boolean;
  briefEnabled: boolean;
  monthlyQuestionLimit: number;
  usedThisMonth: number;
  configured: boolean;
  provider: string | null;
  sandbox: boolean;
  canAsk: boolean;
  canManage: boolean;
}
interface Turn {
  question: string;
  answer: string;
  status: string;
  tools: string[];
  sandbox: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDays = (n: number) => {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - (n - 1));
  return { from: iso(from), to: iso(to) };
};
const TOOL_LABEL: Record<string, string> = {
  list_scope: 'your brands and teams',
  get_summary: 'KPI summary',
  get_breakdown: 'breakdown',
  get_insights: 'insights',
  get_targets: 'targets',
};
const EXAMPLES = [
  'Who in my team needs help this week, and why?',
  'Why did admissions change this month compared with last month?',
  'Which sources and campaigns give the cheapest admissions this month?',
  'Are we on track for our targets?',
];

/** Management insights (A-051) and "Ask the CRM" (A-052) for team leaders and management. */
export default function InsightsPage() {
  const [days, setDays] = useState('7');
  const [brandId, setBrandId] = useState('');
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const range = lastDays(Number(days));
  const q = `from=${range.from}&to=${range.to}${brandId ? `&brandId=${brandId}` : ''}`;
  const insights = useLoad(() => api<InsightsResponse>(`/insights?${q}`), [q]);
  const status = useLoad(() => api<AssistantStatus>('/assistant'));

  return (
    <>
      <PageHeader
        title="Insights & assistant"
        description="What needs attention in your scope, compared with the previous period, and answers to your questions about the numbers."
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card
          title={
            insights.data
              ? `Insights ${insights.data.period.from} – ${insights.data.period.to} (vs ${insights.data.previous.from} – ${insights.data.previous.to})`
              : 'Insights'
          }
          actions={
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="7">Last 7 days</option>
                <option value="14">Last 14 days</option>
                <option value="30">Last 30 days</option>
              </Select>
              {(brands.data?.length ?? 0) > 1 && (
                <Select
                  aria-label="Brand"
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                >
                  <option value="">All brands in my scope</option>
                  {brands.data!.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          }
        >
          <ErrorText error={insights.error} />
          {insights.data && (
            <>
              <p className="mb-3 text-sm text-slate-600">
                {insights.data.headline.leadsCreated} new leads · contact rate{' '}
                {insights.data.headline.contactRatePct ?? '–'}% · first response on time{' '}
                {insights.data.headline.firstResponsePct ?? '–'}% ·{' '}
                {insights.data.headline.admissions} admissions (previous{' '}
                {insights.data.headline.previousAdmissions}) · {insights.data.headline.overdueTasks}{' '}
                overdue tasks
              </p>
              <InsightList items={insights.data.insights} />
            </>
          )}
          {insights.loading && !insights.data && <p className="text-sm text-slate-500">Loading…</p>}
        </Card>
        <div className="space-y-6">
          <ErrorText error={status.error} />
          {status.data && <Assistant status={status.data} onAsked={() => void status.reload()} />}
          {status.data?.canManage && (
            <AssistantSettings status={status.data} onSaved={() => void status.reload()} />
          )}
        </div>
      </div>
    </>
  );
}

function Assistant({ status, onAsked }: { status: AssistantStatus; onAsked: () => void }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const ask = useAction();
  const ready = status.enabled && status.configured && status.canAsk;

  const submit = (text: string) =>
    void ask.run(async () => {
      const history = turns.flatMap((t) => [
        { role: 'user' as const, content: t.question },
        { role: 'assistant' as const, content: t.answer },
      ]);
      const r = await api<{
        answer: string;
        status: string;
        toolsUsed: Array<{ name: string }>;
        sandbox: boolean;
      }>('/assistant/ask', {
        method: 'POST',
        body: { question: text, history: history.slice(-10) },
      });
      setTurns([
        ...turns,
        {
          question: text,
          answer: r.answer,
          status: r.status,
          tools: [...new Set(r.toolsUsed.map((x) => TOOL_LABEL[x.name] ?? x.name))],
          sandbox: r.sandbox,
        },
      ]);
      setQuestion('');
      onAsked();
    });

  return (
    <Card
      title="Ask the CRM"
      actions={
        status.sandbox ? (
          <Badge tone="amber">Sandbox — not the real AI</Badge>
        ) : status.provider ? (
          <Badge tone="blue">AI: Claude</Badge>
        ) : undefined
      }
    >
      {!status.enabled ? (
        <p className="text-sm text-slate-600">
          The assistant is switched off for your organization.
          {status.canManage ? ' Switch it on below.' : ' Ask an organization administrator.'}
        </p>
      ) : !status.configured ? (
        <p className="text-sm text-slate-600">
          The assistant is not set up on this server yet (an AI provider key is needed).
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-600">
            Answers come only from your report figures in your scope (no student details are sent to
            the AI). Check important numbers in Reports. Please do not type student names or phone
            numbers. {status.usedThisMonth} of {status.monthlyQuestionLimit} questions used this
            month.
          </p>
          {turns.length === 0 && (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Example questions">
              {EXAMPLES.map((e) => (
                <Button key={e} variant="secondary" disabled={ask.busy} onClick={() => submit(e)}>
                  {e}
                </Button>
              ))}
            </div>
          )}
          <ol className="mt-4 space-y-4" aria-label="Conversation" aria-live="polite">
            {turns.map((t, i) => (
              <li key={i} className="space-y-2">
                <p className="text-sm font-medium text-slate-900">You: {t.question}</p>
                <div className="rounded-md bg-slate-50 p-3 text-sm whitespace-pre-line text-slate-800 ring-1 ring-slate-200">
                  {t.answer}
                </div>
                {t.tools.length > 0 && (
                  <p className="text-xs text-slate-500">Looked at: {t.tools.join(', ')}</p>
                )}
              </li>
            ))}
          </ol>
          <form
            className="mt-4 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim().length >= 3) submit(question.trim());
            }}
          >
            <label className="block text-sm font-medium text-slate-700" htmlFor="ask">
              Your question
            </label>
            <textarea
              id="ask"
              className="block w-full rounded-md border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
              rows={3}
              maxLength={1000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. Which executives missed the first-response target most this week?"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!ready || ask.busy || question.trim().length < 3}>
                {ask.busy ? 'Thinking…' : 'Ask'}
              </Button>
              {turns.length > 0 && (
                <Button type="button" variant="secondary" onClick={() => setTurns([])}>
                  New conversation
                </Button>
              )}
            </div>
            <ErrorText error={ask.error} />
          </form>
        </>
      )}
    </Card>
  );
}

function AssistantSettings({ status, onSaved }: { status: AssistantStatus; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(status.enabled);
  const [brief, setBrief] = useState(status.briefEnabled);
  const [limit, setLimit] = useState(String(status.monthlyQuestionLimit));
  const save = useAction();
  return (
    <Card title="Assistant settings (organization)">
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Assistant on (team leaders and management can ask questions)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={brief} onChange={(e) => setBrief(e.target.checked)} />
          AI-written summary in the Monday insights e-mail
        </label>
        <Field label="Questions and briefs per month (organization)">
          <Input
            type="number"
            min={0}
            max={100000}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </Field>
        <p className="text-xs text-slate-600">
          Only totals, rates and the names of brands, teams, executives, courses, sources and
          campaigns are sent to the AI provider (Anthropic). Every question and answer is kept for
          review.
        </p>
        <Button
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api('/assistant/settings', {
                method: 'PATCH',
                body: { enabled, briefEnabled: brief, monthlyQuestionLimit: Number(limit) },
              });
              onSaved();
            })
          }
        >
          Save
        </Button>
        <ErrorText error={save.error} />
      </div>
    </Card>
  );
}
