import { describe, expect, it } from 'vitest';
import { isReadyFor, missingTools, parseArgs, planCommands } from './install.mjs';

describe('source installer selection and readiness', () => {
  it('requires an explicit TTS choice in unattended mode and accepts none', () => {
    expect(() => parseArgs(['--yes'])).toThrow('--yes requires an explicit --tts selection');
    expect(parseArgs(['--tts', 'none', '--yes']).tts).toEqual([]);
  });

  it('validates selected engines, languages, and native Windows BreezyVoice refusal', () => {
    expect(() => parseArgs(['--tts', 'all'])).toThrow('--tts must be none');
    expect(() => parseArgs(['--tts', 'breezyvoice', '--languages', 'xx'])).toThrow('--languages accepts');
    expect(() => parseArgs(['--tts', 'breezyvoice'], { platform: 'win32' })).toThrow();
  });

  it('installs only packages mapped from missing OS tools', () => {
    expect(planCommands({ platform: 'darwin', manager: 'brew', missing: ['ffprobe'] })).toEqual([['brew', 'install', 'ffmpeg']]);
    expect(planCommands({ platform: 'darwin', manager: 'brew', missing: ['python'] })).toEqual([['brew', 'install', 'python@3.12']]);
    expect(planCommands({ platform: 'win32', manager: 'winget', missing: ['python'] })[0]).toContain('Python.Python.3.12');
    expect(missingTools(new Set(['git']))).toEqual(['ffmpeg', 'ffprobe']);
    expect(planCommands({ platform: 'linux', manager: 'apt-get', missing: ['git', 'ffmpeg', 'ffprobe'] }))
      .toEqual([['apt-get', 'install', '-y', 'git', 'ffmpeg']]);
  });

  it('requires every requested Kokoro language to be ready', () => {
    expect(isReadyFor('kokoro', ['en-us', 'zh'], { ready: true, installedLanguages: ['en-us'] })).toBe(false);
    expect(isReadyFor('kokoro', ['en-us', 'zh'], { ready: true, languages: [{ id: 'en-us', ready: true }, { id: 'zh', ready: true }] })).toBe(true);
    expect(isReadyFor('breezyvoice', [], { ready: false })).toBe(false);
  });
});
