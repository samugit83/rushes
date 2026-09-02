// Uploads a delivered video, using the title and description from its
// .youtube.txt. SAFE BY DEFAULT: without --confirm it prints the plan and
// uploads nothing.
//
// K11 — this module is OPTIONAL and absent unless `publish` is configured.
// Uploading to a public channel from a stranger's machine on their OAuth token
// is the highest-risk surface in the whole tool, and a video on disk is already
// a complete, useful outcome.
//
// D7 — nothing uploads without a passing receipt whose hashes still match the
// bytes on disk. See gate.ts for the five conditions.

import { readFileSync, writeFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { demoPaths } from '../paths.ts';
import { type ProjectConfig } from '../projectConfig.ts';
import { loadStoryboard } from '../storyboard.ts';
import { txtToMeta } from './youtubeMeta.ts';
import { buildLinkedinPost } from './linkedinPost.ts';
import { checkPublishGate } from './gate.ts';
import { recordPublish } from './catalogue.ts';
import { printDiagnostics } from '../diagnostics.ts';
import { plan as sweepPlan, sweep, mb, type SweepLevel } from '../cleanup.ts';
import { readReceipt, writeReceipt } from '../check/receipt.ts';

export type Privacy = 'private' | 'unlisted' | 'public';

export interface PublishOptions {
  id: string;
  config: ProjectConfig;
  confirm: boolean;
  force: boolean;
  privacy?: Privacy;
  clean: SweepLevel | null;
}

export async function publish(opts: PublishOptions): Promise<number> {
  const { id, config } = opts;
  const yt = config.publish?.youtube;
  if (!yt) {
    process.stderr.write('publishing is not configured for this project (no publish.youtube block).\n'
      + 'The delivered mp4 in out/ is a complete outcome; add the block only if you want uploads.\n');
    return 1;
  }

  const P = demoPaths(id);
  const gate = checkPublishGate(id, opts.force);
  if (gate.diagnostics.length) {
    process.stderr.write('\npublish gate:\n');
    printDiagnostics(gate.diagnostics);
  }
  if (!gate.allowed) {
    process.stderr.write('\nrefusing to publish. Fix the above, or re-run with --force to override deliberately.\n');
    return 1;
  }
  if (opts.force && gate.diagnostics.length) {
    process.stderr.write('\n⚠ --force: publishing against a failing gate. This is recorded in the receipt.\n');
  }

  const meta = txtToMeta(readFileSync(P.youtube, 'utf8'));
  const privacy: Privacy = opts.privacy ?? yt.privacy ?? 'unlisted';
  const willFree = opts.clean ? sweepPlan(id, opts.clean) : null;

  process.stderr.write('\n── upload plan ─────────────────────────────\n');
  process.stderr.write(`  file:        ${P.mp4} (${(statSync(P.mp4).size / 1e6).toFixed(1)} MB)\n`);
  process.stderr.write(`  title:       ${meta.title}\n`);
  process.stderr.write(`  privacy:     ${privacy}\n`);
  process.stderr.write(`  thumbnail:   ${existsSync(P.thumbPng) ? `${id}.thumb.png` : '(none)'}\n`);
  process.stderr.write(`  captions:    ${existsSync(P.vtt) ? `${id}.vtt -> caption track (en)` : '(none)'}\n`);
  process.stderr.write(`  playlist:    ${yt.playlistId ?? yt.playlistTitle ?? '(none)'}\n`);
  process.stderr.write(`  description: ${meta.description.length} chars\n`);
  process.stderr.write(`  cleanup:     ${willFree ? `${opts.clean} — ${willFree.paths.length} entries, ${mb(willFree.bytes)} (after upload)` : 'skipped'}\n`);
  process.stderr.write('────────────────────────────────────────────\n');
  if (!opts.confirm) {
    process.stderr.write('\nDRY RUN — nothing uploaded, nothing deleted. Re-run with --confirm to publish.\n');
    return 0;
  }

  // googleapis is an optional dependency: the module is absent unless a project
  // configured publishing, and the import must not break `rushes build`.
  let google: typeof import('googleapis').google;
  try {
    ({ google } = await import('googleapis'));
  } catch {
    process.stderr.write('googleapis is not installed. Run `npm i googleapis` in the skill root to enable uploads.\n');
    return 1;
  }

  const { loadOAuthClient, tokenPath } = await import('./auth.ts');
  if (!existsSync(tokenPath())) {
    process.stderr.write('not authorized — run `rushes publish-auth` once first\n');
    return 1;
  }
  const youtube = google.youtube({ version: 'v3', auth: await loadOAuthClient() });

  process.stderr.write('\nuploading…\n');
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: yt.tags ?? [],
        categoryId: yt.categoryId ?? '28',
      },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
    },
    media: { body: createReadStream(P.mp4) },
  });
  const vid = res.data.id!;
  const url = `https://youtu.be/${vid}`;
  process.stderr.write(`\n✓ uploaded: ${url}  (privacy: ${privacy})\n`);

  if (existsSync(P.thumbPng)) {
    try {
      await youtube.thumbnails.set({ videoId: vid, media: { body: createReadStream(P.thumbPng) } });
      process.stderr.write('  set custom thumbnail\n');
    } catch (e) {
      process.stderr.write(`  ⚠ thumbnail set failed (the channel may need verification): ${(e as Error).message}\n`);
    }
  }

  // Captions ride along as a real track rather than burned pixels, so viewers
  // can toggle them and the platform can translate them. Never fatal: the video
  // is already up, and a caption failure must not read as a failed publish.
  if (existsSync(P.vtt)) {
    try {
      await youtube.captions.insert({
        part: ['snippet'],
        requestBody: { snippet: { videoId: vid, language: 'en', name: 'English', isDraft: false } },
        media: { body: createReadStream(P.vtt) },
      });
      process.stderr.write('  uploaded caption track (en)\n');
    } catch (e) {
      process.stderr.write(`  ⚠ caption upload failed (the video is uploaded): ${(e as Error).message}\n`);
    }
  }

  if (yt.playlistId) {
    try {
      await youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: { snippet: { playlistId: yt.playlistId, resourceId: { kind: 'youtube#video', videoId: vid } } },
      });
      process.stderr.write('  added to the configured playlist\n');
    } catch (e) {
      process.stderr.write(`  ⚠ playlist step failed (the video is uploaded): ${(e as Error).message}\n`);
    }
  }

  try {
    const { story } = loadStoryboard(id, config);
    writeFileSync(P.linkedin, buildLinkedinPost(story, config, url));
    process.stderr.write(`  linkedin post ready -> ${P.linkedin}\n`);
  } catch (e) {
    process.stderr.write(`  ⚠ linkedin update failed: ${(e as Error).message}\n`);
  }

  recordPublish(id, url);
  const receipt = readReceipt(P.receipt);
  if (receipt) {
    receipt.overridden = opts.force && gate.diagnostics.length > 0;
    writeReceipt(P.receipt, receipt);
  }

  // Last, and never fatal: the upload succeeded, so a failed sweep is a disk
  // nuisance rather than a failed publish. Exiting non-zero here would read as
  // one. Sweeping is bound to a successful upload because that is the moment the
  // video exists somewhere other than this disk.
  if (opts.clean) {
    try {
      const freed = sweep(id, opts.clean);
      process.stderr.write(`  swept ${opts.clean}: ${freed.paths.length} entries, ${mb(freed.bytes)} freed\n`);
    } catch (e) {
      process.stderr.write(`  ⚠ cleanup skipped: ${(e as Error).message}\n`);
    }
  }

  process.stderr.write(`\n✓ published ${url} — deliverables kept in ${P.dir}\n`);
  return 0;
}
