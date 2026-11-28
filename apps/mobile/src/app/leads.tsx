import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { label } from '../lib/logic';
import { OfflineBanner } from '../lib/offline-banner';
import type { LeadRow, Page } from '../lib/types';
import { Banner, Muted, s } from '../lib/ui';
import { useCached } from '../lib/use-cached';

export default function Leads() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const path = `/leads?ownerId=me&sort=recent&pageSize=50${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const leads = useCached<Page<LeadRow>>(path);

  return (
    <View style={s.screen}>
      <View style={[s.pad, { paddingBottom: 0 }]}>
        <TextInput
          style={s.input}
          placeholder="Search name, phone or lead number"
          accessibilityLabel="Search leads"
          value={q}
          onChangeText={setQ}
          autoCorrect={false}
          returnKeyType="search"
        />
        <OfflineBanner stale={leads.stale} savedAt={leads.savedAt} />
        {leads.error ? <Banner tone="red">{leads.error}</Banner> : null}
      </View>
      <FlatList
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        data={leads.data?.items ?? []}
        keyExtractor={(l) => l.id}
        refreshControl={
          <RefreshControl refreshing={leads.loading} onRefresh={() => void leads.reload()} />
        }
        ListEmptyComponent={leads.loading ? undefined : <Muted>No leads found.</Muted>}
        renderItem={({ item: l }) => (
          <Pressable
            accessibilityRole="link"
            onPress={() => router.push(`/lead/${l.id}`)}
            style={s.item}
          >
            <Text style={[s.text, { fontWeight: '600' }]}>
              {l.person.fullName} <Muted>{l.leadNumber}</Muted>
            </Text>
            <Muted>
              {label(l.status)} · {label(l.stage)}
              {l.course ? ` · ${l.course.name}` : ''}
              {l.person.city ? ` · ${l.person.city}` : ''}
            </Muted>
          </Pressable>
        )}
      />
    </View>
  );
}
