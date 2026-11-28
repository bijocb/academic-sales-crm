import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { API_URL } from '../lib/api';
import { useSession } from '../lib/session';
import { Banner, Button, Muted, s } from '../lib/ui';

export default function SignIn() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[s.screen, { justifyContent: 'center' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[s.pad, { maxWidth: 420, width: '100%', alignSelf: 'center' }]}>
        <Text style={s.h1} accessibilityRole="header">
          Sign in
        </Text>
        <Muted>Use your CRM account.</Muted>
        <Text style={s.text} nativeID="email-label">
          Email
        </Text>
        <TextInput
          style={s.input}
          accessibilityLabelledBy="email-label"
          accessibilityLabel="Email"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          value={email}
          onChangeText={setEmail}
        />
        <Text style={s.text} nativeID="password-label">
          Password
        </Text>
        <TextInput
          style={s.input}
          accessibilityLabelledBy="password-label"
          accessibilityLabel="Password"
          secureTextEntry
          autoComplete="password"
          textContentType="password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={() => void submit()}
        />
        {error ? <Banner tone="red">{error}</Banner> : null}
        <Button
          title="Sign in"
          busy={busy}
          disabled={!email || !password}
          onPress={() => void submit()}
        />
        <Muted>Server: {API_URL.replace(/\/api\/v1$/, '')}</Muted>
      </View>
    </KeyboardAvoidingView>
  );
}
