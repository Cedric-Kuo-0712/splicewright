import { expect, it } from 'vitest';
import { validateTrialCoverage } from './export-memory-validate.mjs';

it('accepts three complete cases with one active-window method', () => {
  const result = {
    config: {
      cases: ['sequential-10', 'sequential-100', 'sequential-200'].map(id => ({ id, audio: false })),
      methods: [{ id: 'candidate-active-window', experimentalActiveWindow: true }],
    },
    trials: ['sequential-10', 'sequential-100', 'sequential-200'].map(id => ({
      name: `${id}-candidate-active-window`,
      result: { status: 'DONE', case: id, method: 'candidate-active-window', output: `${id}.mp4` },
    })),
  };
  expect(validateTrialCoverage(result)).toHaveLength(3);
});

it('rejects a missing or duplicated case-method pair', () => {
  const result = {
    config: { cases: [{ id: 'a' }, { id: 'b' }], methods: [{ id: 'm' }] },
    trials: [
      { name: 'a-m', result: { status: 'DONE', case: 'a', method: 'm', output: 'a.mp4' } },
      { name: 'duplicate-a-m', result: { status: 'DONE', case: 'a', method: 'm', output: 'a2.mp4' } },
    ],
  };
  expect(() => validateTrialCoverage(result)).toThrow(/Unexpected or duplicate/);
});
