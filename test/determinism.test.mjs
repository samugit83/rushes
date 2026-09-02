// The mux is deterministic (T2).
//
// Exposing the re-cut as a command has two payoffs, and this test is what makes
// the second one real: fixing a caption typo stops costing a re-record, AND the
// mux becomes testable, because the same inputs must produce the same output.
//
// `-fflags +bitexact` plus stripped metadata removes the encoder version string
// and the timestamps that would otherwise differ between two runs of identical
// work. What is left is the actual encode, and if that differs the inputs were
// not what we thought they were.

import { test, assert, equal } from './harness.mjs';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasFfmpeg } from '../lib/compose/ffprobe.ts';
import { buildBody, freezeSpans } from '../lib/compose/mux.ts';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

await test('two bit-exact muxes of the same inputs produce the same bytes', async () => {
  if (!hasFfmpeg()) { process.stderr.write('    · skipped: ffmpeg is unavailable\n'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'rushes-mux-'));
  try {
    // A synthetic screencast and a synthetic narration clip: this test is about
    // the mux, not about the recorder or the voice.
    const webm = join(dir, 'recording.webm');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc=size=640x360:rate=30:duration=6', '-c:v', 'libvpx', '-b:v', '1M', webm], { stdio: 'ignore' });
    const mp3 = join(dir, 'line.mp3');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', mp3], { stdio: 'ignore' });

    const timeline = [{ sceneId: 'a', startMs: 0, endMs: 4000, actionEndMs: 1500,
                        narration: 'one', audioPath: mp3, audioDurationMs: 2000 }];
    const config = { baseUrl: 'http://127.0.0.1', video: { width: 640, height: 360, fps: 30, bitrate: '1M' } };

    const outs = [];
    for (const name of ['a.mp4', 'b.mp4']) {
      const out = join(dir, name);
      buildBody({ webm, timeline, durationMs: 6000, leadTrimMs: 500, out, config, bitexact: true, freezeDeadAir: true });
      assert(existsSync(out), `${name} was not produced`);
      outs.push(sha(out));
    }
    equal(outs[0], outs[1], 'the same inputs produced different bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('the freeze graph is built from the timeline, not from a guess', () => {
  // A scene whose steps finish at 1.5s but whose voice runs to 4s holds the last
  // action frame for 2.5s. The total length is unchanged by construction, which
  // is what keeps every caption cue and chapter timestamp valid.
  const spans = freezeSpans([{ sceneId: 'a', startMs: 0, endMs: 4000, actionEndMs: 1500, narration: '' }]);
  equal(spans, [{ atMs: 1500, holdMs: 2500 }]);
  void writeFileSync;
});
