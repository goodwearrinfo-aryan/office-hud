// The React binding for voice dictation.
//
// Kept apart from `voiceInput.ts` on purpose: that module holds pure helpers
// and is imported by node:test from the server suite, where `react` is not on
// the resolution path. This one is browser-only.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describeVoiceError,
  isVoiceSupported,
  speechRecognitionCtor,
  transcriptFromEvent,
  type SpeechRecognitionLike,
} from './voiceInput';

export interface VoiceDictation {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * Dictation that appends recognised text to the command field.
 *
 * Nothing here submits. The recognised phrase is handed to `onText` and the
 * user still has to route it deliberately, so the preview/confirm gate applies
 * to spoken commands exactly as it does to typed ones.
 */
export function useVoiceDictation(onText: (text: string) => void): VoiceDictation {
  const supported = isVoiceSupported();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  // Held in a ref so changing the callback identity between renders does not
  // tear down a recognition session that is mid-phrase.
  const sink = useRef(onText);
  sink.current = onText;

  const stop = useCallback(() => {
    recognition.current?.stop();
    recognition.current = null;
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      setError('This browser has no Web Speech API. Type the command instead.');
      return;
    }
    setError(null);
    const instance = new Ctor();
    instance.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
    instance.continuous = false;
    instance.interimResults = false;
    instance.maxAlternatives = 1;
    instance.onresult = event => {
      const text = transcriptFromEvent(event);
      if (text) sink.current(text);
    };
    instance.onerror = event => {
      setError(describeVoiceError(event?.error ?? 'unknown'));
      setListening(false);
    };
    instance.onend = () => {
      setListening(false);
      recognition.current = null;
    };
    recognition.current = instance;
    try {
      instance.start();
      setListening(true);
    } catch (startError: any) {
      // start() throws when a session is already running.
      setError(`Voice input could not start (${startError?.message || startError}).`);
      setListening(false);
    }
  }, []);

  // Stop on unmount so a session cannot outlive the component and keep the mic
  // open after the panel is gone.
  useEffect(() => () => {
    try { recognition.current?.abort(); } catch { /* already stopped */ }
    recognition.current = null;
  }, []);

  return { supported, listening, error, start, stop };
}