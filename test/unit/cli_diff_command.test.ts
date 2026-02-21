import test from 'node:test';
import assert from 'node:assert/strict';
import { toDaemonRequest } from '../../src/cli/human-browser.ts';
import { HBError } from '../../src/shared/errors.ts';

test('diff snapshot maps to daemon diff_snapshot command', () => {
  const request = toDaemonRequest('diff', ['snapshot', '--baseline', 'before.txt', '--selector', '#main', '--compact', '--depth', '3']);
  assert.equal(request.command, 'diff_snapshot');
  assert.deepEqual(request.args, {
    baseline: 'before.txt',
    selector: '#main',
    compact: true,
    depth: 3,
  });
});

test('diff screenshot requires baseline', () => {
  assert.throws(
    () => {
      toDaemonRequest('diff', ['screenshot']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});

test('diff screenshot parses threshold/output/selector/full', () => {
  const request = toDaemonRequest('diff', [
    'screenshot',
    '--baseline',
    'before.png',
    '--output',
    'diff.png',
    '--threshold',
    '0.2',
    '--selector',
    '#hero',
    '--full',
  ]);
  assert.equal(request.command, 'diff_screenshot');
  assert.deepEqual(request.args, {
    baseline: 'before.png',
    output: 'diff.png',
    threshold: 0.2,
    selector: '#hero',
    full_page: true,
  });
});

test('diff url parses screenshot/full/wait-until/snapshot options', () => {
  const request = toDaemonRequest('diff', [
    'url',
    'https://a.example',
    'https://b.example',
    '--screenshot',
    '--full',
    '--wait-until',
    'networkidle',
    '--selector',
    '#app',
    '--compact',
    '--depth',
    '2',
  ]);
  assert.equal(request.command, 'diff_url');
  assert.deepEqual(request.args, {
    url1: 'https://a.example',
    url2: 'https://b.example',
    screenshot: true,
    full_page: true,
    wait_until: 'networkidle',
    selector: '#app',
    compact: true,
    depth: 2,
  });
});
