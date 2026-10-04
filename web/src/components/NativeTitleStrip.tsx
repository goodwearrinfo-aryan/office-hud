import { isNative } from '../native';

/**
 * The strip the native shell reserves above the HUD for the inset traffic
 * lights.
 *
 * It renders nothing in a browser, so the web build is unchanged. In the shell
 * it carries the one piece of context the page has nowhere else to put it: which
 * hive is being read, and whether that feed is actually live. That matters most
 * when the HUD is being served locally because the forward to the deployment
 * host is down — "live" and "CONNECTING" look identical in the body, but they
 * are very different situations.
 */

export type NativeConnectionTone = 'is-live' | 'is-offline' | 'is-connecting' | 'is-error';

export default function NativeTitleStrip({
  label,
  tone,
  connectionLabel,
}: {
  label: string | null | undefined;
  tone: NativeConnectionTone;
  connectionLabel: string;
}) {
  // isNative() is false in a browser, so the strip collapses to nothing and the
  // body's padding rule (scoped to html[data-native='1']) never applies.
  if (!isNative()) return null;

  return (
    <div className="hud-native-strip" aria-hidden="true">
      <span className="hud-native-strip-title">Office HUD</span>
      {label ? <span className="hud-native-strip-hive">{label}</span> : null}
      <span className={`hud-connection ${tone}`} role="status" aria-label={`Connection status: ${connectionLabel}`}>
        <span className="hud-connection-dot" />
      </span>
    </div>
  );
}