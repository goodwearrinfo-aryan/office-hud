import type { JarvisPreview } from './api';

/**
 * The browser's one way of asking what a command would do.
 *
 * In a module rather than inside a console for the same reason fleetTruth is: the
 * rule that matters -- an unanswered preview is UNKNOWN, never safe -- has to be
 * assertable without a browser. See server/test/jarvisPreview.test.ts.
 *
 * Both consoles used to carry their own copy of the danger regex. They are now
 * both empty of it, and neither can drift, because neither decides.
 */

export interface JarvisCommandInput {
  prompt: string;
  target?: string | null;
  priority?: string;
}

/**
 * Ask the server to judge a command. Writes nothing, so this is safe to call on
 * every keystroke and from any machine.
 *
 * Returns null when the server could not be asked. That is deliberately distinct
 * from a preview that came back saying "normal": one is an answer, the other is
 * the absence of one, and the UI must not confuse them.
 */
export async function previewJarvisCommand(input: JarvisCommandInput): Promise<JarvisPreview | null> {
  try {
    const response = await fetch('/api/jarvis/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: input.prompt,
        target: input.target || null,
        priority: input.priority,
      }),
    });
    if (!response.ok) return null;
    return await response.json() as JarvisPreview;
  } catch {
    return null;
  }
}

/**
 * The tier label to show.
 *
 * With no preview the honest answer is UNKNOWN. Showing OPS TASK there would be
 * the exact failure this workstream exists to remove: a command marked safe
 * because nobody had checked.
 */
export function riskLabel(preview: JarvisPreview | null): 'DESTRUCTIVE' | 'OPS TASK' | 'UNKNOWN' {
  if (!preview || !preview.ok) return 'UNKNOWN';
  return preview.risk === 'destructive' ? 'DESTRUCTIVE' : 'OPS TASK';
}

/** Whether the operator must type EXECUTE. Unknown preview means ask, not proceed. */
export function needsTypeConfirmation(preview: JarvisPreview | null): boolean {
  return !preview || preview.requires_type_confirmation === true;
}

/**
 * Whether the confirm button may be pressed.
 *
 * Three separate things have to be true and they are reported separately on
 * purpose: the fields are good, this host may dispatch, and whatever
 * confirmation the command needs has been typed. Collapsing them into one boolean
 * is how a console ends up disabling a button for the wrong reason.
 */
export function canDispatch(
  preview: JarvisPreview | null,
  typeConfirmation: string,
): { allowed: boolean; reason: string | null } {
  if (!preview) return { allowed: false, reason: 'The office has not judged this command yet.' };
  if (!preview.ok) return { allowed: false, reason: preview.reason };
  if (!preview.queue_available) return { allowed: false, reason: 'The JEV task queue is unavailable on this host.' };
  if (!preview.dispatch.available) {
    return { allowed: false, reason: preview.blocked_reason || preview.dispatch.requirement };
  }
  if (preview.requires_type_confirmation && typeConfirmation.trim().toUpperCase() !== 'EXECUTE') {
    return { allowed: false, reason: 'Type EXECUTE to authorize this command.' };
  }
  return { allowed: true, reason: null };
}

/** Which agent would own the work, in words. Never invents a name for a null. */
export function ownerLabel(preview: JarvisPreview | null): string {
  if (!preview || !preview.ok) return 'not routed';
  if (preview.assigned_agent) return preview.assigned_agent;
  return 'JEV auto-route';
}

/**
 * How the router decided, when it decided anything.
 *
 * An unrouted command says so rather than showing an empty selector, because
 * "no domain matched" is a real outcome and the operator should be able to see
 * that their phrasing did not reach the polymarket router at all.
 */
export function routingLabel(preview: JarvisPreview | null): string | null {
  const routing = preview?.routing;
  if (!routing) return null;
  const selector = routing.selector ? routing.selector.replace(/_/g, ' ') : null;
  return selector ? `${routing.domain} · ${selector} → ${routing.resolved_target ?? 'unresolved'}` : String(routing.domain);
}