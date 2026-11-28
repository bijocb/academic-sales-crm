import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { api, ApiError } from '../../lib/api';
import {
  CALL_OUTCOMES,
  callDuration,
  callPlan,
  defaultFollowUp,
  FOLLOW_UP_LABEL,
  FOLLOW_UPS,
  label,
  SITUATIONS,
  telUrl,
  type CallOutcome,
  type FollowUp,
  type TaskRow,
} from '../../lib/logic';
import { OfflineBanner } from '../../lib/offline-banner';
import type { LeadDetail, PersonalWhatsApp, TimelineItem } from '../../lib/types';
import { Banner, Button, Card, Chip, Muted, s } from '../../lib/ui';
import { useCached } from '../../lib/use-cached';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** Log the call just made: outcome, notes and the next follow-up in one step. */
function CallLog({
  leadId,
  tasks,
  startedAt,
  durationSec,
  onDone,
  onCancel,
}: {
  leadId: string;
  tasks: TaskRow[];
  startedAt: Date;
  durationSec: number | null;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [followUp, setFollowUp] = useState<FollowUp>('TOMORROW');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!outcome) return;
    setBusy(true);
    setError(null);
    try {
      const plan = callPlan({
        leadId,
        tasks,
        outcome,
        notes,
        startedAt,
        durationSec,
        followUp,
        now: new Date(),
      });
      if (plan.kind === 'complete') {
        await api(`/tasks/${plan.taskId}/complete`, { method: 'POST', body: plan.body });
      } else {
        await api(`/leads/${leadId}/calls`, { method: 'POST', body: plan.body });
        if (plan.nextTask)
          await api(`/leads/${leadId}/tasks`, { method: 'POST', body: plan.nextTask });
      }
      onDone(
        `Call logged: ${label(outcome).toLowerCase()}${followUp !== 'NONE' ? `; follow-up ${FOLLOW_UP_LABEL[followUp].toLowerCase()}` : ''}.`,
      );
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'NEXT_ACTION_REQUIRED'
          ? 'This lead needs a next follow-up — pick one above.'
          : errText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="How did the call go?">
      {durationSec !== null ? (
        <Muted>About {Math.max(1, Math.round(durationSec / 60))} min</Muted>
      ) : null}
      <View style={s.row} accessibilityRole="radiogroup" accessibilityLabel="Call outcome">
        {CALL_OUTCOMES.map((o) => (
          <Chip
            key={o}
            title={label(o)}
            selected={outcome === o}
            onPress={() => {
              setOutcome(o);
              setFollowUp(defaultFollowUp(o));
            }}
          />
        ))}
      </View>
      <Text style={s.text}>Next follow-up</Text>
      <View style={s.row} accessibilityRole="radiogroup" accessibilityLabel="Next follow-up">
        {FOLLOW_UPS.map((f) => (
          <Chip
            key={f}
            title={FOLLOW_UP_LABEL[f]}
            selected={followUp === f}
            onPress={() => setFollowUp(f)}
          />
        ))}
      </View>
      <TextInput
        style={[s.input, { minHeight: 70, textAlignVertical: 'top', paddingTop: 10 }]}
        placeholder="Notes (optional)"
        accessibilityLabel="Call notes"
        multiline
        value={notes}
        onChangeText={setNotes}
      />
      {error ? <Banner tone="red">{error}</Banner> : null}
      <View style={s.row}>
        <Button title="Save" busy={busy} disabled={!outcome} onPress={() => void save()} />
        <Button title="Cancel" variant="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}

export default function LeadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lead = useCached<LeadDetail>(`/leads/${id}`);
  const timeline = useCached<TimelineItem[]>(`/leads/${id}/timeline`);
  const tasks = useCached<TaskRow[]>(`/leads/${id}/tasks`);
  const [call, setCall] = useState<{ startedAt: Date; durationSec: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyWa, setBusyWa] = useState<string | null>(null);
  const dialing = useRef<Date | null>(null);

  // Coming back from the phone app after dialling opens the call log.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && dialing.current) {
        const startedAt = dialing.current;
        dialing.current = null;
        setCall({ startedAt, durationSec: callDuration(startedAt, new Date()) });
      }
    });
    return () => sub.remove();
  }, []);

  const reloadAll = () => Promise.all([lead.reload(), timeline.reload(), tasks.reload()]);
  const l = lead.data;
  const tel = l ? telUrl(l.person.phone, l.person.piiMasked) : null;
  const stale = lead.stale || timeline.stale;

  const dial = async () => {
    if (!tel) return;
    setNotice(null);
    dialing.current = new Date();
    await Linking.openURL(tel).catch(() => {
      dialing.current = null;
      setError('This phone cannot make calls.');
    });
  };

  const whatsapp = async (category: string) => {
    setBusyWa(category);
    setError(null);
    setNotice(null);
    try {
      const p = await api<PersonalWhatsApp>(
        `/leads/${id}/messages/personal-whatsapp?category=${category}`,
      );
      if (!p.ready || !p.url) {
        setError(p.reason ?? 'No approved WhatsApp template for this situation.');
        return;
      }
      await Linking.openURL(p.url);
      // WhatsApp opens with the text filled in; the executive presses send there. Record it in the timeline.
      await api(`/leads/${id}/messages/personal-whatsapp`, { method: 'POST', body: { category } });
      setNotice(`${label(category)} opened in WhatsApp and added to the timeline.`);
      void timeline.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyWa(null);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: l?.person.fullName ?? 'Lead' }} />
      <ScrollView
        style={s.screen}
        contentContainerStyle={s.pad}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={lead.loading} onRefresh={() => void reloadAll()} />
        }
      >
        <OfflineBanner stale={stale} savedAt={lead.savedAt} />
        {lead.error ? <Banner tone="red">{lead.error}</Banner> : null}
        {notice ? <Banner tone="green">{notice}</Banner> : null}
        {error ? <Banner tone="red">{error}</Banner> : null}

        {l ? (
          <Card>
            <Text style={s.h1}>{l.person.fullName}</Text>
            <Muted>
              {l.leadNumber} · {label(l.status)} · {label(l.stage)}
            </Muted>
            {l.course ? <Text style={s.text}>Course: {l.course.name}</Text> : null}
            {l.person.phone ? <Text style={s.text}>Phone: {l.person.phone}</Text> : null}
            {l.person.email ? <Text style={s.text}>Email: {l.person.email}</Text> : null}
            {l.person.city ? <Text style={s.text}>City: {l.person.city}</Text> : null}
            {l.owner ? <Muted>Owner: {l.owner.name}</Muted> : null}
            {l.person.doNotContact ? (
              <Banner tone="red">Do not contact — this person opted out.</Banner>
            ) : null}
          </Card>
        ) : null}

        {l && l.canEdit && !l.person.doNotContact ? (
          call ? (
            <CallLog
              leadId={id}
              tasks={tasks.data ?? []}
              startedAt={call.startedAt}
              durationSec={call.durationSec}
              onCancel={() => setCall(null)}
              onDone={(msg) => {
                setCall(null);
                setNotice(msg);
                void reloadAll();
              }}
            />
          ) : (
            <Card title="Call">
              <View style={s.row}>
                <Button
                  title="Call now"
                  disabled={!tel || stale}
                  onPress={() => void dial()}
                  accessibilityHint="Opens the phone app; when you come back you log the outcome"
                />
                <Button
                  title="Log a call"
                  variant="secondary"
                  disabled={stale}
                  onPress={() => setCall({ startedAt: new Date(), durationSec: null })}
                />
              </View>
              {!tel ? <Muted>No full phone number on this lead.</Muted> : null}
            </Card>
          )
        ) : null}

        {l && l.canEdit && !l.person.doNotContact ? (
          <Card title="WhatsApp from my phone">
            <Muted>Opens WhatsApp with the approved message filled in. Press send there.</Muted>
            <View style={s.row}>
              {SITUATIONS.map((c) => (
                <Button
                  key={c}
                  title={label(c)}
                  variant="secondary"
                  busy={busyWa === c}
                  disabled={stale || (busyWa !== null && busyWa !== c)}
                  onPress={() => void whatsapp(c)}
                />
              ))}
            </View>
          </Card>
        ) : null}

        <Card title="Open tasks">
          {(tasks.data ?? [])
            .filter((t) => t.status === 'OPEN')
            .map((t) => (
              <View key={t.id} style={s.item}>
                <Text style={s.text}>{t.title}</Text>
                <Muted>
                  Due {new Date(t.dueAt).toLocaleString()}
                  {t.overdue ? ' · overdue' : ''}
                </Muted>
              </View>
            ))}
          {tasks.data && !tasks.data.some((t) => t.status === 'OPEN') ? (
            <Muted>No open tasks.</Muted>
          ) : null}
        </Card>

        <Card title="Timeline">
          {(timeline.data ?? []).slice(0, 30).map((t) => (
            <View key={t.id} style={s.item}>
              <Text style={s.text}>{t.title}</Text>
              {t.body ? <Text style={{ color: '#334155' }}>{t.body}</Text> : null}
              <Muted>
                {new Date(t.at).toLocaleString()}
                {t.actor ? ` · ${t.actor}` : ''}
              </Muted>
            </View>
          ))}
          {timeline.data && !timeline.data.length ? <Muted>Nothing yet.</Muted> : null}
        </Card>
      </ScrollView>
    </>
  );
}
