// Turns a narration line into an MP3 and measures its duration. That duration is
// the clock the whole video aligns to: the driver holds every scene for at least
// the length of its voice, so narration can never be cut off.
//
// Cached by sha1(provider + voice + model + text), so re-runs of unchanged lines
// cost nothing. The PROVIDER is in the key on purpose (Q5): switching between
// the hosted and the local voice must not silently reuse the wrong one.
//
// The hosted path asks for character-level timestamps and stores them beside the
// mp3. That alignment is what L4's word-anchored slide beats are built on, and
// it costs nothing extra: the same request returns both.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { env, SKILL_ROOT } from '../env.ts';
import { applyPronunciation } from '../pronunciation.ts';
import { ffprobeDurationMs } from './ffprobe.ts';
import type { ProjectConfig } from '../projectConfig.ts';

const MODEL_ID = 'eleven_multilingual_v2';

export type TtsProvider = 'elevenlabs' | 'local';

export interface Clip { path: string; durationMs: number; alignmentPath?: string }

function cacheDir(): string {
  // Cache under the skill, not the filmed project: the same line in two projects
  // is the same audio, and a project checkout should not carry 36 MB of mp3.
  return join(SKILL_ROOT, 'cache', 'audio');
}

export function ttsProvider(): TtsProvider {
  return process.env.RUSHES_TTS === 'local' ? 'local' : 'elevenlabs';
}

/** Local voice for a rehearsal, a CI re-render or a draft cut: zero characters. */
function synthLocal(spoken: string, outPath: string): void {
  // A silent clip whose LENGTH is right is enough for every timing decision the
  // pipeline makes; nothing that ships uses it. Speaking rate ~15 chars/second.
  const seconds = Math.max(1.2, spoken.length / 15);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=44100`,
    '-t', seconds.toFixed(3), '-c:a', 'libmp3lame', '-b:a', '64k', outPath,
  ], { stdio: 'ignore' });
}

export async function synth(text: string, config?: ProjectConfig): Promise<Clip> {
  const provider = ttsProvider();
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });

  const spoken = applyPronunciation(text, config?.pronunciation);
  const voiceId = provider === 'local' ? 'local' : env().voiceId;
  const hash = createHash('sha1').update(`${provider}:${voiceId}:${MODEL_ID}:${spoken}`).digest('hex').slice(0, 16);
  const outPath = join(dir, `${hash}.mp3`);
  const alignPath = join(dir, `${hash}.align.json`);

  if (!existsSync(outPath)) {
    if (provider === 'local') {
      synthLocal(spoken, outPath);
    } else {
      const { elevenKey } = env();
      // with-timestamps returns the audio AND the character alignment in one
      // call, which is the whole basis of word-anchored beats.
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spoken, model_id: MODEL_ID }),
        },
      );
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
      const body = await res.json() as { audio_base64?: string; alignment?: unknown };
      if (!body.audio_base64) throw new Error('ElevenLabs returned no audio');
      writeFileSync(outPath, Buffer.from(body.audio_base64, 'base64'));
      if (body.alignment) writeFileSync(alignPath, JSON.stringify(body.alignment));
    }
  }

  return {
    path: outPath,
    durationMs: ffprobeDurationMs(outPath),
    alignmentPath: existsSync(alignPath) ? alignPath : undefined,
  };
}

/** Every clip a storyboard needs, in one place, so a build can report cost. */
export async function synthAll(lines: string[], config?: ProjectConfig): Promise<Clip[]> {
  const out: Clip[] = [];
  for (const line of lines) out.push(await synth(line, config));
  return out;
}

export function readCachedAlignment(clip: Clip): unknown | null {
  return clip.alignmentPath && existsSync(clip.alignmentPath)
    ? JSON.parse(readFileSync(clip.alignmentPath, 'utf8'))
    : null;
}
