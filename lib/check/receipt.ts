// The receipt: what was built, from what, measured how, and by whom (D6, SP8).
//
// It exists so two questions have answers after the fact. "Is this mp4 the one
// that passed the checks?" — the artifact sha256 says so. "Which target was
// filmed, as whom, with whose approval?" — the resolved baseUrl, its resolved
// IP, the tenant, the auth strategy, the recording identity and the consent
// answer say so. Without those an operator cannot reconstruct a publish, which
// for a tool that uploads publicly is not an acceptable gap.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { QualityProfile } from '../config.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { scrub } from '../secrets.ts';
import type { CheckResult, CheckSummary } from './index.ts';

export interface Receipt {
  schemaVersion: 1;
  id: string;
  profile: QualityProfile;
  builtAt: string;
  tool: { commit: string; version: string };

  config: { sha256: string; baseUrl: string; resolvedIp: string | null; authStrategy: string };
  storyboard: { sha256: string; bytes: number; schemaVersion: number };
  artifact: { sha256: string; bytes: number; durationMs: number };
  timeline: { sha256: string; sceneCount: number; leadTrimMs: number };

  recording: {
    identity: string | null;
    scope: string | null;
    hostsContacted: { host: string; ip: string; external: boolean }[];
    /** The resolver pinning applied at launch, or null if nothing was pinned. */
    hostRules: string | null;
    preflight: { method: string; path: string; status: number; restoreAfter: boolean }[];
    publishConsent: string | null;
    externalConsent: string | null;
    volatileScenes: string[];
  };

  checks: CheckResult[];
  summary: CheckSummary;

  rehearsal: { status: 'agreed' | 'disagreed' | 'skipped'; passes: number; exemptScenes: string[] };
  frameEvidence: { status: 'passed' | 'failed' | 'skipped'; artifactSha256: string | null; frames: number };
  narrationCheck: { verified: number; unverified: number; inconclusive: number };
  humanReview: { status: 'pending' | 'passed' | 'failed'; reviewer: string | null };

  diagnostics: Diagnostic[];
  overridden: boolean;
}

export function toolCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/** SP5: the receipt is written through the scrubber, like every other artifact. */
export function writeReceipt(path: string, receipt: Receipt): void {
  writeFileSync(path, JSON.stringify(scrub(receipt), null, 2));
}

export function readReceipt(path: string): Receipt | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as Receipt; } catch { return null; }
}

/** Every field SP8 requires present and non-empty. */
export function auditableFields(r: Receipt): string[] {
  const missing: string[] = [];
  if (!r.config.sha256) missing.push('config.sha256');
  if (!r.config.baseUrl) missing.push('config.baseUrl');
  if (!r.config.authStrategy) missing.push('config.authStrategy');
  if (!r.storyboard.sha256) missing.push('storyboard.sha256');
  if (!r.artifact.sha256) missing.push('artifact.sha256');
  if (!r.builtAt) missing.push('builtAt');
  if (!r.tool.commit) missing.push('tool.commit');
  if (r.recording.publishConsent == null) missing.push('recording.publishConsent');
  if (r.recording.identity == null && r.config.authStrategy !== 'none') missing.push('recording.identity');
  return missing;
}

/** The handoff receipt the agent reports (E6). Never more than it measured. */
export function handoffReport(r: Receipt, artifactPath: string, correctionRounds: number): string {
  return [
    `demo_id:            ${r.id}`,
    `artifact:           ${artifactPath}`,
    `storyboard_sha256:  ${r.storyboard.sha256}`,
    `artifact_sha256:    ${r.artifact.sha256}`,
    `validation:         ${r.summary.checks} ${r.profile}, ${r.summary.errors} errors, ${r.summary.warnings} warnings`,
    `rehearsal:          ${r.rehearsal.status}`,
    `frame_evidence:     ${r.frameEvidence.status}`,
    `narration_check:    ${r.narrationCheck.unverified > 0 ? 'unverified' : r.narrationCheck.verified > 0 ? 'verified' : 'inconclusive'}`,
    `human_review:       ${r.humanReview.status}`,
    `correction_rounds:  ${correctionRounds}`,
  ].join('\n');
}
