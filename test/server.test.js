'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildIvrResponse,
  isSafeRecordingPath,
  toYemotApiPath,
  timingSafeEqualText,
  sessionIdFromParams
} = require('../src/server');

test('formats an IVR text response', () => {
  assert.equal(buildIvrResponse('שלום\nמה נשמע?'), 'read=t-שלום מה נשמע?');
});

test('limits very long IVR responses', () => {
  assert.ok(buildIvrResponse('א'.repeat(1000)).length <= 'read=t-'.length + 850);
});

test('accepts normal Yemot recording paths', () => {
  assert.equal(isSafeRecordingPath('07/api/005.wav'), true);
  assert.equal(isSafeRecordingPath('/07/api/005.wav'), true);
  assert.equal(isSafeRecordingPath('ivr2:/07/api/005.wav'), true);
});

test('rejects unsafe recording paths', () => {
  assert.equal(isSafeRecordingPath('../secret.wav'), false);
  assert.equal(isSafeRecordingPath('07/../../secret.wav'), false);
  assert.equal(isSafeRecordingPath('https://example.com/file.wav'), false);
  assert.equal(isSafeRecordingPath('07/a?token=secret.wav'), false);
});

test('normalizes recording path for Yemot API', () => {
  assert.equal(toYemotApiPath('/07/api/005.wav'), 'ivr2:/07/api/005.wav');
  assert.equal(toYemotApiPath('ivr2:07/api/005.wav'), 'ivr2:/07/api/005.wav');
});

test('compares access keys without accepting empty values', () => {
  assert.equal(timingSafeEqualText('abc123', 'abc123'), true);
  assert.equal(timingSafeEqualText('abc123', 'abc124'), false);
  assert.equal(timingSafeEqualText('', ''), false);
});

test('extracts a session identifier from the call id', () => {
  assert.equal(sessionIdFromParams({ call_id: 'call-123' }), 'call-123');
  assert.equal(sessionIdFromParams({ phone: '0501234567' }), '0501234567');
  assert.equal(sessionIdFromParams({}), null);
});
