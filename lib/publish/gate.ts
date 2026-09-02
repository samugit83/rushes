// The publish gate (D7). Before this existed, the only thing standing between a
// rendered file and a public upload was `existsSync(<id>.mp4)`.
//
// Five conditions, all required:
//   - a receipt exists
//   - it was produced at the showcase profile
//   - it recorded zero errors
//   - its storyboard sha256 equals the storyboard on disk NOW
//   - its artifact sha256 equals the mp4 on disk NOW
//
// The storyboard clause closes a live hole rather than a theoretical one: you
// could edit the storyboard after recording, regenerate youtube.txt from the new
// one, and upload chapter timestamps that did not match the video.
//
// `--force` exists, writes `overridden: true` into the receipt, and prints a
// loud warning. It is never silent.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { demoPaths } from '../paths.ts';
import { storyboardPath } from '../storyboard.ts';
import { readReceipt, auditableFields, type Receipt } from '../check/receipt.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';

export interface GateResult { allowed: boolean; receipt: Receipt | null; diagnostics: Diagnostic[] }

function sha256(path: string): string | null {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

export function checkPublishGate(id: string, force = false): GateResult {
  const P = demoPaths(id);
  const diagnostics: Diagnostic[] = [];
  const receipt = readReceipt(P.receipt);

  if (!receipt) {
    diagnostics.push(diag('delivery/receipt-mismatch', 'error',
      `no receipt at ${P.receipt}`, { id }, {},
      ['run `rushes deliver ' + id + '` first']));
    return { allowed: force, receipt: null, diagnostics };
  }

  if (receipt.profile !== 'showcase') {
    diagnostics.push(diag('delivery/receipt-mismatch', 'error',
      `the receipt was produced at the "${receipt.profile}" profile, not "showcase"`,
      { id }, { profile: receipt.profile },
      [`run \`rushes deliver ${id} --quality showcase\``]));
  }

  if (receipt.summary.errors > 0) {
    diagnostics.push(diag('delivery/receipt-mismatch', 'error',
      `the receipt records ${receipt.summary.errors} check error(s)`,
      { id }, { summary: receipt.summary },
      ['fix the diagnostics in the receipt and re-deliver']));
  }

  const storyNow = sha256(storyboardPath(id));
  if (storyNow !== receipt.storyboard.sha256) {
    diagnostics.push(diag('delivery/receipt-mismatch', 'error',
      'the storyboard has changed since the video was built',
      { id }, { receipt: receipt.storyboard.sha256, onDisk: storyNow },
      ['re-run `rushes deliver` so the chapters match the video',
       'revert the storyboard edit']));
  }

  const artifactNow = sha256(P.mp4);
  if (artifactNow !== receipt.artifact.sha256) {
    diagnostics.push(diag('delivery/receipt-mismatch', 'error',
      'the mp4 on disk is not the one that passed the checks',
      { id }, { receipt: receipt.artifact.sha256, onDisk: artifactNow },
      ['re-run `rushes deliver`']));
  }

  const missing = auditableFields(receipt);
  if (missing.length) {
    diagnostics.push(diag('delivery/receipt-mismatch', 'error',
      `the receipt is missing auditable fields: ${missing.join(', ')}`,
      { id }, { missing },
      ['re-run `rushes deliver`; a publish must stay reconstructable afterwards']));
  }

  const allowed = diagnostics.length === 0 || force;
  return { allowed, receipt, diagnostics };
}
