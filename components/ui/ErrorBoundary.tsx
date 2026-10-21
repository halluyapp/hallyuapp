/**
 * Leaf error boundary — MUST stay free of app UI / store / auth imports.
 * Root layout imports this during cold boot. Heavy imports caused:
 * TypeError: Cannot read property 'ErrorBoundary' of undefined
 */
import React from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';

interface Props {
  children: React.ReactNode;
  scope?: string;
  onReset?: () => void;
  silent?: boolean;
}
interface State {
  error: Error | null;
}

const CANVAS = '#000000';
const SURFACE = '#161618';
const TEXT = '#F5F5F7';
const TEXT_SECONDARY = '#8E8E93';
const TEXT_TERTIARY = '#48484A';
const ACCENT = '#E11D48';

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { track } = require('../../lib/analytics') as {
        track: (event: string, props?: Record<string, unknown>) => void;
      };
      track('error.boundary', {
        message: error.message,
        scope: this.props.scope ?? 'screen',
        silent: !!this.props.silent,
        stack: info.componentStack?.slice(0, 600),
      });
    } catch {
      /* ignore */
    }
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  share = async () => {
    const e = this.state.error;
    if (!e) return;
    await Share.share({
      message: `Hallyu error report\n${e.name}: ${e.message}\n${(e.stack ?? '').slice(0, 1200)}`,
    }).catch(() => {});
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.silent) return null;
    const scope = this.props.scope ?? 'this screen';
    const body =
      scope === 'Hallyu'
        ? 'Hallyu hit a snag it couldn’t recover from. Your watchlist and drafts are safe on this device.'
        : `We couldn’t draw ${scope}. Your data is safe — try again, or head back.`;

    return (
      <View style={styles.host} accessibilityRole="alert">
        <View style={styles.icon}>
          <Text style={styles.iconGlyph}>!</Text>
        </View>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>{body}</Text>
        {this.state.error.message ? (
          <Text style={styles.dev} numberOfLines={4}>
            {`${this.state.error.name}: ${this.state.error.message}`}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable onPress={this.reset} style={styles.primaryBtn} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.primaryLabel}>Try again</Text>
          </Pressable>
          <Pressable onPress={this.share} style={styles.ghostBtn} accessibilityRole="button" accessibilityLabel="Send error details">
            <Text style={styles.ghostLabel}>Send error details</Text>
          </Pressable>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  host: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: CANVAS },
  icon: { width: 56, height: 56, borderRadius: 28, backgroundColor: SURFACE, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  iconGlyph: { color: TEXT_SECONDARY, fontSize: 22, fontWeight: '600' },
  title: { color: TEXT, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  body: { color: TEXT_SECONDARY, fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 320 },
  dev: { color: TEXT_TERTIARY, fontSize: 12, textAlign: 'center', maxWidth: 340 },
  actions: { alignItems: 'center', gap: 8, marginTop: 12 },
  primaryBtn: { backgroundColor: ACCENT, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, minWidth: 160, alignItems: 'center' },
  primaryLabel: { color: TEXT, fontSize: 15, fontWeight: '600' },
  ghostBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  ghostLabel: { color: TEXT_SECONDARY, fontSize: 14 },
});
