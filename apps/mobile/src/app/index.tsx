import { Link, router, Stack } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { endOfDay, groupToday, label, relative, type TaskRow } from '../lib/logic';
import { OfflineBanner } from '../lib/offline-banner';
import { useSession } from '../lib/session';
import type { LeadRow, Page } from '../lib/types';
import { Banner, Button, Card, colors, Muted, s } from '../lib/ui';
import { useCached } from '../lib/use-cached';

function TaskItem({ t }: { t: TaskRow }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${t.title}, ${t.lead?.person.fullName ?? ''}, due ${relative(t.dueAt, new Date())}`}
      onPress={() => router.push(`/lead/${t.leadId}`)}
      style={s.item}
    >
      <Text style={[s.text, { fontWeight: '600' }]}>{t.lead?.person.fullName ?? t.title}</Text>
      <Text style={{ color: t.overdue ? colors.danger : colors.muted, fontSize: 13 }}>
        {t.title} · {t.overdue ? 'overdue ' : 'due '}
        {relative(t.dueAt, new Date())}
        {t.priority === 'HIGH' || t.priority === 'URGENT' ? ` · ${label(t.priority)}` : ''}
      </Text>
    </Pressable>
  );
}

export default function Today() {
  const { state, pushNote, signOut } = useSession();
  const until = useMemo(() => endOfDay(new Date()), []);
  const tasks = useCached<TaskRow[]>(
    `/tasks?view=mine&status=OPEN&dueBefore=${encodeURIComponent(until)}`,
  );
  const leads = useCached<Page<LeadRow>>('/leads?ownerId=me&status=OPEN&sort=priority&pageSize=10');
  const groups = groupToday(tasks.data ?? []);
  const name = state.status === 'signedIn' ? state.me.user.name : '';

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/leads" style={{ color: colors.primary, fontSize: 16, padding: 8 }}>
              Leads
            </Link>
          ),
        }}
      />
      <ScrollView
        style={s.screen}
        contentContainerStyle={s.pad}
        refreshControl={
          <RefreshControl
            refreshing={tasks.loading || leads.loading}
            onRefresh={() => void Promise.all([tasks.reload(), leads.reload()])}
          />
        }
      >
        {name ? <Text style={s.h1}>Hello, {name.split(' ')[0]}</Text> : null}
        <OfflineBanner stale={tasks.stale} savedAt={tasks.savedAt} />
        {pushNote ? <Banner>{pushNote}</Banner> : null}
        {tasks.error ? <Banner tone="red">{tasks.error}</Banner> : null}

        <Card title={`Overdue (${groups.overdue.length})`}>
          {groups.overdue.slice(0, 20).map((t) => (
            <TaskItem key={t.id} t={t} />
          ))}
          {groups.overdue.length > 20 ? (
            <Muted>and {groups.overdue.length - 20} more — oldest shown first.</Muted>
          ) : null}
          {groups.overdue.length ? null : <Muted>Nothing overdue.</Muted>}
        </Card>
        <Card title={`Due today (${groups.today.length})`}>
          {groups.today.length ? (
            groups.today.map((t) => <TaskItem key={t.id} t={t} />)
          ) : (
            <Muted>No more tasks today.</Muted>
          )}
        </Card>
        <Card title="Priority leads">
          {(leads.data?.items ?? []).map((l) => (
            <Pressable
              key={l.id}
              accessibilityRole="link"
              onPress={() => router.push(`/lead/${l.id}`)}
              style={s.item}
            >
              <Text style={[s.text, { fontWeight: '600' }]}>{l.person.fullName}</Text>
              <Muted>
                {l.priority ? `${label(l.priority.band)} priority · ` : ''}
                {label(l.stage)}
                {l.course ? ` · ${l.course.name}` : ''}
              </Muted>
            </Pressable>
          ))}
          {leads.data && !leads.data.items.length ? <Muted>No open leads.</Muted> : null}
        </Card>
        <View style={{ marginTop: 8 }}>
          <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
        </View>
      </ScrollView>
    </>
  );
}
