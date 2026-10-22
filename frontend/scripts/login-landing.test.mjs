import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/AppRoutes.jsx', import.meta.url), 'utf8');

test('Taskosphere is checked before People Matrix for the login landing', () => {
  assert.match(src, /function taskosphereLanding\(/);
  const order = (re) => src.search(re);
  assert.ok(order(/taskosphereLanding\(user, isPlatformOwner\) \|\| peopleMatrixLanding\(user\)/) > -1, 'PublicOnly checks Taskosphere first');
  assert.ok(order(/taskosphereLanding\(user, isPlatformOwner\) \|\| peopleMatrixPath/) > -1, 'dashboard home checks Taskosphere first');
});
