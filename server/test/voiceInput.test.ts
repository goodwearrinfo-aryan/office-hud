/**
 * Voice dictation rules.
 *
 * The React binding needs a browser and this repo has no jsdom, so what is
 * tested here is the part that decides what text reaches the prompt -- plus two
 * source-level assertions, because the property that matters most about voice
 * is a negative one: it must not be able to submit anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeVoiceError,
  isVoiceSupported,
  speechRecognitionCtor,
  transcriptFromEvent,
  type SpeechRecognitionEventLike,
} from '../../web/src/voiceInput.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, '..', '..', ...parts), 'utf8');

class FakeRecognition {}

test('the prefixed and unprefixed constructors are both found', () => {
  assert.equal(typeof speechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition }), 'function');
  assert.equal(typeof speechRecognitionCtor({ SpeechRecognition: FakeRecognition }), 'function');
});

test('the prefixed name wins when both exist', () => {
  // Safari only exposes webkitSpeechRecognition, so it has to take priority.
  class Webkit {}
  class Unprefixed {}
  assert.equal(
    speechRecognitionCtor({ webkitSpeechRecognition: Webkit, SpeechRecognition: Unprefixed }),
    Webkit,
  );
});

test('a browser with neither reports unsupported rather than throwing', () => {
  assert.equal(speechRecognitionCtor({}), null);
  assert.equal(speechRecognitionCtor(null), null);
  assert.equal(isVoiceSupported({}), false);
  assert.equal(isVoiceSupported({ webkitSpeechRecognition: FakeRecognition }), true);
});

test('only final results reach the prompt', () => {
  // Interim results fire continuously while the user speaks; appending them
  // would duplicate text as the phrase firms up.
  const event = {
    resultIndex: 0,
    results: [
      { isFinal: false, length: 1, 0: { transcript: 'check the ', confidence: 0.7 } },
      { isFinal: true, length: 1, 0: { transcript: 'ledger floor', confidence: 0.9 } },
    ],
  } as unknown as SpeechRecognitionEventLike;
  assert.equal(transcriptFromEvent(event), 'ledger floor');
});

test('alternatives are kept, not silently dropped', () => {
  // maxAlternatives is set to 1, but a browser may return more than asked.
  const event = {
    results: [{ isFinal: true, length: 2, 0: { transcript: 'restart', confidence: 0.9 }, 1: { transcript: 'restarted', confidence: 0.4 } }],
  } as unknown as SpeechRecognitionEventLike;
  assert.equal(transcriptFromEvent(event), 'restart restarted');
});

test('whitespace collapses and a malformed event does not throw', () => {
  const event = { results: [{ isFinal: true, length: 1, 0: { transcript: '  ship   it  ', confidence: 1 } }] } as unknown as SpeechRecognitionEventLike;
  assert.equal(transcriptFromEvent(event), 'ship it');
  assert.equal(transcriptFromEvent({} as SpeechRecognitionEventLike), '');
  assert.equal(transcriptFromEvent({ results: [] } as unknown as SpeechRecognitionEventLike), '');
});

test('every failure message offers typing as the way out', () => {
  for (const code of ['not-allowed', 'no-speech', 'audio-capture', 'network']) {
    assert.match(describeVoiceError(code), /type/i, `${code} should point at typing`);
  }
  assert.match(describeVoiceError('not-allowed'), /permission|refused/i);
  assert.match(describeVoiceError('mystery'), /mystery/);
});

test('voice cannot submit: the hook never submits and the mic is type="button"', () => {
  // The property that matters. If voice could submit, it would be a path around
  // the preview -> confirm -> dispatch gate that typing has to pass.
  const hook = read('web', 'src', 'useVoiceDictation.ts');
  assert.equal(/\.submit\(\)/.test(hook), false, 'the hook must not submit the form');
  assert.equal(/onSubmit/.test(hook), false, 'the hook must not attach a submit handler');

  const jarvis = read('web', 'src', 'components', 'JarvisConsole.tsx');
  const mic = /<button\b[^>]*type="button"[^>]*aria-label=\{voice\.listening/s.exec(jarvis);
  assert.ok(mic, 'the mic control must be type="button" so Enter still routes deliberately');
});
