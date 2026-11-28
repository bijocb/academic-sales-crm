import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export const colors = {
  bg: '#f8fafc',
  card: '#ffffff',
  text: '#0f172a',
  muted: '#475569',
  line: '#e2e8f0',
  primary: '#1d4ed8',
  danger: '#b91c1c',
  amberBg: '#fef3c7',
  amberText: '#78350f',
  green: '#15803d',
};

export function Card({
  title,
  children,
  style,
}: {
  title?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[s.card, style]}>
      {title ? (
        <Text style={s.cardTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      accessibilityHint={accessibilityHint}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        variant === 'primary' ? s.btnPrimary : variant === 'danger' ? s.btnDanger : s.btnSecondary,
        off && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'secondary' ? colors.primary : '#fff'} />
      ) : (
        <Text style={[s.btnText, variant === 'secondary' && { color: colors.primary }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Chip({
  title,
  selected,
  onPress,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[s.chip, selected && s.chipOn]}
    >
      <Text style={[s.chipText, selected && { color: '#fff' }]}>{title}</Text>
    </Pressable>
  );
}

/** Offline / stale-data banner and other notices. */
export function Banner({
  children,
  tone = 'amber',
}: {
  children: ReactNode;
  tone?: 'amber' | 'red' | 'green';
}) {
  return (
    <View
      accessibilityRole="alert"
      style={[
        s.banner,
        tone === 'red' && { backgroundColor: '#fee2e2' },
        tone === 'green' && { backgroundColor: '#dcfce7' },
      ]}
    >
      <Text
        style={{
          color: tone === 'red' ? colors.danger : tone === 'green' ? '#14532d' : colors.amberText,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={{ color: colors.muted, fontSize: 13 }}>{children}</Text>;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 16, gap: 12 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line,
  },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  h1: { fontSize: 22, fontWeight: '700', color: colors.text },
  text: { fontSize: 15, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  btn: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: colors.primary },
  btnDanger: { backgroundColor: colors.danger },
  btnSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.primary },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  chip: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, color: colors.text },
  banner: { backgroundColor: colors.amberBg, padding: 10, borderRadius: 8 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
    backgroundColor: '#fff',
    color: colors.text,
  },
  item: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, gap: 2 },
});
