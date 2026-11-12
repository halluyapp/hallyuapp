export type PublishingMode = 'approval' | 'autonomous';

export interface AgentProtocol {
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
}

/** Large broadcasts always require approval. Routine publishing can be configured by staff. */
export function requiresApproval(tool: string, mode: PublishingMode): boolean {
  if (tool === 'send_broadcast') return true;
  return mode === 'approval' && ['publish_post', 'reply_comment', 'create_poll', 'notify_member'].includes(tool);
}

export function parseAgentProtocol(content: string): AgentProtocol {
  const trimmed = content.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return { final: trimmed };
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1)) as AgentProtocol;
    if (typeof value.final === 'string') return { final: value.final };
    if (typeof value.tool === 'string') return { tool: value.tool, args: value.args && typeof value.args === 'object' && !Array.isArray(value.args) ? value.args : {} };
    return { final: trimmed };
  } catch {
    return { final: trimmed };
  }
}

export function boundedText(value: unknown, maximum: number): string {
  return String(value ?? '').trim().slice(0, maximum);
}

export function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
