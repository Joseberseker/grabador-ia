import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration, formatBytes, buildFileName } from '../src/shared/format.js';
import { toUserError, isUserCancellation } from '../src/shared/errors.js';
import { pickMimeType, WEBM_CANDIDATES } from '../src/recording/mime-type.js';
import { Msg, Target, COMMANDS } from '../src/shared/messages.js';
import { ElapsedClock } from '../src/shared/elapsed-clock.js';
import { Status, INITIAL_STATE, ACTIVE_STATUSES, getElapsedMs, isActive } from '../src/shared/state.js';
import { STATUS_UI, VISIBLE_ACTIONS } from '../src/shared/ui/status-ui.js';

test('formatDuration', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(999), '00:00');
  assert.equal(formatDuration(1000), '00:01');
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatDuration(-5000), '00:00');
  assert.equal(formatDuration(undefined), '00:00');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('buildFileName usa hora local y extensión webm', () => {
  const date = new Date(2026, 9, 6, 14, 3, 9);
  assert.equal(buildFileName(date), 'grabacion-2026-10-06_14-03-09.webm');
  assert.match(buildFileName(), /^grabacion-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.webm$/);
});

test('toUserError: la cancelación del selector se identifica y se explica', () => {
  const cancel = toUserError(new DOMException('Permission denied', 'NotAllowedError'));
  assert.equal(cancel.code, 'NotAllowedError');
  assert.match(cancel.message, /cancelada/i);
  assert.ok(isUserCancellation(cancel));

  for (const name of ['InvalidStateError', 'NotFoundError', 'NotReadableError', 'AbortError', 'NotSupportedError', 'SecurityError']) {
    const e = toUserError(new DOMException('x', name));
    assert.equal(e.code, name);
    assert.ok(!e.message.startsWith('Error inesperado'), name);
    assert.ok(!isUserCancellation(e), name);
  }
});

test('toUserError tolera errores desconocidos y es serializable', () => {
  assert.match(toUserError(new RangeError('boom')).message, /Error inesperado: boom/);
  assert.equal(toUserError(undefined).code, 'UnknownError');
  assert.doesNotThrow(() => JSON.stringify(toUserError(new Error('x'))));
});

test('pickMimeType elige el primer WebM soportado', () => {
  assert.equal(pickMimeType(() => true), WEBM_CANDIDATES[0]);
  assert.equal(pickMimeType((t) => !t.includes('vp9')), 'video/webm;codecs=vp8,opus');
  assert.equal(pickMimeType(() => false), '');
});

test('ElapsedClock: 10 s grabando + 5 s en pausa + 3 s grabando = 13 s', () => {
  const c = new ElapsedClock();
  c.start(0);
  assert.equal(c.elapsed(10_000), 10_000);
  c.pause(10_000);
  assert.equal(c.elapsed(15_000), 10_000, 'la pausa no cuenta');
  assert.deepEqual(c.snapshot(), { elapsedMs: 10_000, segmentStartedAt: null });
  c.resume(15_000);
  assert.equal(c.elapsed(18_000), 13_000);
  assert.equal(c.stop(18_000), 13_000);
  assert.equal(c.elapsed(99_000), 13_000, 'parado no avanza');
});

test('ElapsedClock: pausar/reanudar dos veces es idempotente; start reinicia', () => {
  const c = new ElapsedClock();
  c.start(1000);
  c.pause(2000);
  c.pause(5000);
  c.resume(6000);
  c.resume(9000);
  assert.equal(c.elapsed(7000), 2000);
  c.start(50_000);
  assert.equal(c.elapsed(51_000), 1000);
});

test('getElapsedMs reconstruye el temporizador desde el estado guardado', () => {
  const now = 100_000;
  assert.equal(getElapsedMs(INITIAL_STATE, now), 0);
  assert.equal(getElapsedMs({ status: Status.RECORDING, elapsedMs: 10_000, segmentStartedAt: 97_000 }, now), 13_000);
  // En pausa se ignora segmentStartedAt aunque venga relleno.
  assert.equal(getElapsedMs({ status: Status.PAUSED, elapsedMs: 10_000, segmentStartedAt: 97_000 }, now), 10_000);
  // Reloj desfasado: nunca negativo.
  assert.equal(getElapsedMs({ status: Status.RECORDING, elapsedMs: 0, segmentStartedAt: now + 500 }, now), 0);
});

test('estados: todos tienen etiqueta y acciones; los activos no permiten «start»', () => {
  for (const status of Object.values(Status)) {
    assert.ok(STATUS_UI[status]?.label, status);
    assert.ok(Array.isArray(VISIBLE_ACTIONS[status]), status);
  }
  for (const status of ACTIVE_STATUSES) {
    assert.ok(isActive(status));
    assert.ok(!VISIBLE_ACTIONS[status].includes('start'), status);
  }
  assert.ok(!isActive(Status.IDLE) && !isActive(Status.FINISHED));
  assert.deepEqual(VISIBLE_ACTIONS[Status.RECORDING], ['pause', 'stop']);
  assert.deepEqual(VISIBLE_ACTIONS[Status.PAUSED], ['resume', 'stop']);
  assert.equal(STATUS_UI[Status.IDLE].label, 'LISTO');
  assert.equal(STATUS_UI[Status.RECORDING].label, 'GRABANDO');
  assert.equal(STATUS_UI[Status.PAUSED].label, 'PAUSADO');
  assert.equal(STATUS_UI[Status.FINISHED].label, 'FINALIZADO');
});

test('mensajes y atajos', () => {
  const values = Object.values(Msg);
  assert.equal(new Set(values).size, values.length);
  assert.equal(new Set(Object.values(Target)).size, Object.values(Target).length);
  for (const type of Object.values(COMMANDS)) assert.ok(values.includes(type));
});
