import React, { useMemo } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { colors, fonts, radius, space } from '../../constants/theme';
import { Text } from './Text';

/**
 * Dependency-free Markdown renderer for AI replies.
 *
 * The operator streams real Markdown (headings, bold, italics, inline code, fenced code,
 * bullet/numbered lists and links). Rendering it as a single raw Text node makes replies
 * unreadable, so this walks the source line-by-line and emits native text spans. It is
 * intentionally a small subset: anything it does not understand is shown verbatim rather than
 * dropped, so a malformed reply is still legible.
 */

type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

const INLINE_PATTERN = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g;

function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(source)) !== null) {
    if (match.index > last) out.push({ text: source.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      out.push({ text: token.slice(2, -2), bold: true });
    } else if (token.startsWith('`')) {
      out.push({ text: token.slice(1, -1), code: true });
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) out.push({ text: linkMatch[1], href: linkMatch[2] });
      else out.push({ text: token });
    } else {
      out.push({ text: token.slice(1, -1), italic: true });
    }
    last = match.index + token.length;
  }
  if (last < source.length) out.push({ text: source.slice(last) });
  return out;
}

function InlineText({ source, tone }: { source: string; tone?: 'primary' | 'onAccent' }) {
  const parts = useMemo(() => parseInline(source), [source]);
  return (
    <Text variant="body" style={{ color: tone === 'onAccent' ? colors.onAccent : colors.textPrimary }}>
      {parts.map((part, index) => {
        if (part.code) {
          return (
            <Text
              key={index}
              variant="body"
              style={{ fontFamily: fonts.medium, backgroundColor: colors.surface2, color: colors.textPrimary }}
            >
              {` ${part.text} `}
            </Text>
          );
        }
        if (part.href) {
          return (
            <Text
              key={index}
              variant="body"
              style={{ color: colors.accent, textDecorationLine: 'underline' }}
              onPress={() => {
                void Linking.openURL(part.href as string).catch(() => undefined);
              }}
            >
              {part.text}
            </Text>
          );
        }
        return (
          <Text
            key={index}
            variant="body"
            style={{
              fontFamily: part.bold ? fonts.bold : part.italic ? fonts.medium : undefined,
              fontStyle: part.italic ? 'italic' : undefined,
              color: tone === 'onAccent' ? colors.onAccent : colors.textPrimary,
            }}
          >
            {part.text}
          </Text>
        );
      })}
    </Text>
  );
}

export function Markdown({ source, tone }: { source: string; tone?: 'primary' | 'onAccent' }) {
  const blocks = useMemo(() => {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const rendered: React.ReactNode[] = [];
    let code: string[] | null = null;
    let bullets: string[] = [];

    const flushBullets = () => {
      if (bullets.length === 0) return;
      rendered.push(
        <View key={`ul-${rendered.length}`} style={styles.list}>
          {bullets.map((item, index) => (
            <View key={index} style={styles.listRow}>
              <Text variant="body" style={{ color: tone === 'onAccent' ? colors.onAccent : colors.textPrimary }}>
                {'\u2022'}
              </Text>
              <View style={{ flex: 1 }}>
                <InlineText source={item} tone={tone} />
              </View>
            </View>
          ))}
        </View>,
      );
      bullets = [];
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.trim().startsWith('```')) {
        if (code) {
          rendered.push(
            <View key={`code-${rendered.length}`} style={styles.codeBlock}>
              <Text variant="caption" style={{ fontFamily: fonts.medium, color: colors.textPrimary }}>
                {code.join('\n')}
              </Text>
            </View>,
          );
          code = null;
        } else {
          flushBullets();
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(raw);
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        bullets.push(bullet[1]);
        continue;
      }
      flushBullets();
      if (line.trim().length === 0) continue;
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        rendered.push(
          <Text
            key={`h-${rendered.length}`}
            variant={heading[1].length <= 2 ? 'titleSmall' : 'label'}
            style={{ marginTop: space.x1, color: tone === 'onAccent' ? colors.onAccent : colors.textPrimary }}
          >
            {heading[2]}
          </Text>,
        );
        continue;
      }
      const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
      if (numbered) {
        rendered.push(
          <View key={`ol-${rendered.length}`} style={styles.listRow}>
            <Text variant="body" style={{ color: tone === 'onAccent' ? colors.onAccent : colors.textPrimary }}>
              {numbered[1]}.
            </Text>
            <View style={{ flex: 1 }}>
              <InlineText source={numbered[2]} tone={tone} />
            </View>
          </View>,
        );
        continue;
      }
      rendered.push(<InlineText key={`p-${rendered.length}`} source={line} tone={tone} />);
    }
    flushBullets();
    if (code && code.length > 0) {
      rendered.push(
        <View key={`code-${rendered.length}`} style={styles.codeBlock}>
          <Text variant="caption" style={{ fontFamily: fonts.medium, color: colors.textPrimary }}>
            {code.join('\n')}
          </Text>
        </View>,
      );
    }
    return rendered;
  }, [source, tone]);

  return <View style={{ gap: space.x1 }}>{blocks}</View>;
}

const styles = StyleSheet.create({
  list: { gap: 2 },
  listRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  codeBlock: {
    backgroundColor: colors.surface2,
    borderRadius: radius.sm,
    padding: space.x2,
  },
});
