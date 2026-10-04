// Voice input for the Jarvis command bar.
//
// Deliberately just a dictation surface: recognised text lands in the prompt
// field and nothing else. It does NOT submit. Routing a command still goes
// through preview -> confirm -> dispatch, so speaking cannot bypass the gate
// that typing has to pass -- voice is a faster keyboard, not a new authority.
//
// The Web Speech API is Chromium/Safari only and is not in TypeScript's DOM
// library, so the shapes it needs are declared here rather than scattered
// through the component.

// The subset of SpeechRecognition this module actually uses.
export interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}
export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}
export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * The browser's SpeechRecognition constructor, or null when the browser has
 * none. Safari ships it as `webkitSpeechRecognition`; Chrome has had both, with
 * the unprefixed name arriving later -- so both are checked, prefixed first
 * because that is the one Safari exposes.
 */
export function speechRecognitionCtor(scope: unknown = globalThis): SpeechRecognitionCtor | null {
  const host = scope as Record<string, unknown> | null;
  if (!host) return null;
  const candidate = host.webkitSpeechRecognition ?? host.SpeechRecognition;
  return typeof candidate === 'function' ? (candidate as SpeechRecognitionCtor) : null;
}

export function isVoiceSupported(scope: unknown = globalThis): boolean {
  return speechRecognitionCtor(scope) !== null;
}

/**
 * The final transcript from a recognition event.
 *
 * Only `isFinal` results are used. Interim results fire continuously while the
 * user speaks, and appending them would duplicate text as the phrase firms up.
 * Alternatives are joined rather than taking [0]: `maxAlternatives` is set to 1,
 * so the list holds a single candidate, but a browser is free to return more
 * and dropping them silently would look like a recognition failure.
 */
export function transcriptFromEvent(event: SpeechRecognitionEventLike): string {
  const results = event?.results;
  if (!results) return '';
  const parts: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result?.isFinal) continue;
    for (let j = 0; j < result.length; j += 1) {
      const alternative = result[j];
      if (alternative?.transcript) parts.push(alternative.transcript);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Error text safe to show, since the browser's own codes are terse. */
export function describeVoiceError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was refused. Allow it in the browser, or type the command instead.';
    case 'no-speech':
      return 'No speech was heard. Try again, or type the command.';
    case 'audio-capture':
      return 'No microphone was found. Type the command instead.';
    case 'network':
      return 'Speech recognition needs a network connection and could not reach it. Type the command instead.';
    case 'aborted':
      return 'Listening stopped.';
    default:
      return `Voice input failed (${code}). Type the command instead.`;
  }
}