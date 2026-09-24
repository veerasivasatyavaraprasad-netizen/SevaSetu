import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { api } from './api';

const light = {
  bg: '#f6f7f9', surface: '#ffffff', surface2: '#f1f4f6', text: '#111827', muted: '#5b6472', border: '#e3e7ec',
  brand: '#0f766e', brandInk: '#ffffff', brandSoft: '#e6f4f2', danger: '#b42318', dangerSoft: '#fdecea',
  warn: '#9a6700', warnSoft: '#fff5d6', ok: '#067647', okSoft: '#e7f6ee',
};
const dark = {
  bg: '#0d1117', surface: '#161b22', surface2: '#1d242d', text: '#e6edf3', muted: '#9aa5b1', border: '#2b3440',
  brand: '#2dd4bf', brandInk: '#062a27', brandSoft: '#10302d', danger: '#f97066', dangerSoft: '#3a1714',
  warn: '#fdb022', warnSoft: '#3a2a06', ok: '#47cd89', okSoft: '#0c2e1d',
};

export function useTheme() {
  return useColorScheme() === 'dark' ? dark : light;
}

// Loads data; reloads whenever the screen regains focus. Returns [data, error, reload].
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null });
  const load = useCallback(() => {
    if (!path) return Promise.resolve();
    return api(path).then((data) => setState({ data, error: null })).catch((error) => setState((s) => ({ data: s.data, error })));
  }, [path]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  return [state.data, state.error, load];
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Screen({ children, onRefresh, scroll = true }) {
  const t = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = onRefresh ? async () => { setRefreshing(true); await onRefresh(); setRefreshing(false); } : undefined;
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={refresh ? <RefreshControl refreshing={refreshing} onRefresh={refresh} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : <View style={{ flex: 1, padding: 16, gap: 12 }}>{children}</View>;
  return <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: t.bg }}>{body}</SafeAreaView>;
}

export function Card({ children, style, onPress }) {
  const t = useTheme();
  const s = [styles.card, { backgroundColor: t.surface, borderColor: t.border }, style];
  if (onPress) {
    return <Pressable onPress={onPress} style={({ pressed }) => [...s, pressed && { opacity: 0.7 }]} accessibilityRole="button">{children}</Pressable>;
  }
  return <View style={s}>{children}</View>;
}

export function T({ children, style, muted, small, bold, big, center, ...rest }) {
  const t = useTheme();
  return (
    <Text
      style={[{ color: muted ? t.muted : t.text, fontSize: big ? 20 : small ? 13 : 15, lineHeight: big ? 26 : small ? 18 : 21 },
        bold && { fontWeight: '700' }, big && { fontWeight: '700' }, center && { textAlign: 'center' }, style]}
      {...rest}
    >
      {children}
    </Text>
  );
}

export function H({ children, level = 1 }) {
  const t = useTheme();
  return <Text accessibilityRole="header" style={{ color: t.text, fontWeight: '700', fontSize: level === 1 ? 22 : 17, marginBottom: 2 }}>{children}</Text>;
}

export function Button({ title, onPress, kind = 'default', disabled, busy, small }) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.brand : kind === 'danger' ? t.dangerSoft : kind === 'ghost' ? 'transparent' : t.surface;
  const fg = kind === 'primary' ? t.brandInk : kind === 'danger' ? t.danger : kind === 'ghost' ? t.brand : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.btn, small && styles.btnSmall,
        { backgroundColor: bg, borderColor: kind === 'default' ? t.border : 'transparent', opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '700', fontSize: small ? 13 : 15 }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, style, ...props }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ color: t.muted, fontWeight: '600', fontSize: 13, marginBottom: 4 }}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.text, backgroundColor: t.surface, borderColor: t.border }, style]}
        accessibilityLabel={label}
        {...props}
      />
    </View>
  );
}

export function Check({ checked, onChange, children }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => onChange(!checked)} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginVertical: 8 }}>
      <View style={[styles.box, { borderColor: checked ? t.brand : t.border, backgroundColor: checked ? t.brand : t.surface }]}>
        {checked && <Text style={{ color: t.brandInk, fontWeight: '900', fontSize: 13 }}>✓</Text>}
      </View>
      <Text style={{ color: t.text, flex: 1, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </Pressable>
  );
}

export function Chips({ options, value, onChange }) {
  const t = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {options.map(([v, label]) => (
        <Pressable key={v} onPress={() => onChange(v)} accessibilityRole="button" accessibilityState={{ selected: v === value }}
          style={[styles.chip, { borderColor: v === value ? t.brand : t.border, backgroundColor: v === value ? t.brand : t.surface }]}>
          <Text style={{ color: v === value ? t.brandInk : t.text, fontSize: 14 }}>{label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function Badge({ children, tone }) {
  const t = useTheme();
  const map = { ok: [t.okSoft, t.ok], warn: [t.warnSoft, t.warn], danger: [t.dangerSoft, t.danger], brand: [t.brandSoft, t.brand] };
  const [bg, fg] = map[tone] || [t.surface2, t.muted];
  return <View style={[styles.badge, { backgroundColor: bg }]}><Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{children}</Text></View>;
}

export function Banner({ children, tone = 'info' }) {
  const t = useTheme();
  const map = { info: [t.brandSoft, t.brand], warn: [t.warnSoft, t.warn], danger: [t.dangerSoft, t.danger], ok: [t.okSoft, t.ok] };
  const [bg, edge] = map[tone];
  return <View style={[styles.banner, { backgroundColor: bg, borderLeftColor: edge }]}>{typeof children === 'string' ? <T small>{children}</T> : children}</View>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  const details = error.body?.details;
  return (
    <Banner tone="danger">
      <T small>{error.message}</T>
      {Array.isArray(details) && details.map((d) => <T small key={d.path + d.message}>• {d.path ? `${d.path}: ` : ''}{d.message}</T>)}
    </Banner>
  );
}

export function Loading() {
  const t = useTheme();
  return <ActivityIndicator style={{ margin: 32 }} color={t.brand} />;
}

export function Row({ children, style }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'space-between' }, style]}>{children}</View>;
}

const STATUS = {
  pending_payment: ['Awaiting payment', 'warn'], paid: ['Finding a professional', 'brand'], assigned: ['Professional assigned', 'brand'],
  in_progress: ['In progress', 'brand'], completed: ['Completed — please confirm', 'ok'], confirmed: ['Done', 'ok'],
  disputed: ['Issue under review', 'danger'], cancelled: ['Cancelled', ''], refunded: ['Refunded', ''],
};
const WORKER_STATUS = { assigned: 'Upcoming', completed: 'Awaiting confirmation', disputed: 'Under review' };

export function StatusBadge({ status, forWorker }) {
  const [label, tone] = STATUS[status] || [status, ''];
  return <Badge tone={tone}>{(forWorker && WORKER_STATUS[status]) || label}</Badge>;
}

export function useInterval(fn, ms) {
  useEffect(() => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, ms]);
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 6 },
  btn: { minHeight: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnSmall: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 46, fontSize: 16 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  banner: { borderRadius: 12, padding: 12, borderLeftWidth: 4, gap: 4 },
});
