// Slide source types, and the capacity table that stands in for a layout solver.

export type SlideMode = 'composed' | 'authored';

export type BlockKind =
  | 'title' | 'bullets' | 'flow-row' | 'sequence' | 'ring' | 'compare'
  | 'stack' | 'hub' | 'store' | 'badge-list' | 'metric' | 'code' | 'quote';

export type Tone =
  | 'neutral' | 'frontend' | 'backend' | 'database' | 'security'
  | 'bus' | 'external' | 'accent' | 'danger';

export interface SlideItem {
  id?: string;
  label?: string;
  detail?: string;
  tone?: Tone;
  badge?: string;
  value?: string;
  items?: string[];
}

export interface Connector {
  from: string;
  to: string;
  style?: 'solid' | 'dashed';
  kind?: 'read' | 'write' | 'both';
  label?: string;
  travel?: boolean;
}

export interface SlideSource {
  schemaVersion?: 1;
  id: string;
  mode?: SlideMode;
  block?: BlockKind;
  title?: string;
  subtitle?: string;
  kicker?: string;
  intent?: string;
  reference?: string;
  items?: SlideItem[];
  connectors?: Connector[];
  body?: string;
  language?: string;
  attribution?: string;
  html?: string;
  css?: string;
  notes?: string;
}

/**
 * Every block declares a maximum. Exceeding it is not a layout problem to be
 * solved by shrinking the type — it is an editorial one, and the supported fixes
 * say so: split the slide, choose a different block, or cut an item.
 */
export const CAPACITY: Record<BlockKind, number> = {
  title: 1,
  bullets: 6,
  'flow-row': 8,
  sequence: 8,
  ring: 4,
  compare: 3,
  stack: 6,
  hub: 8,
  store: 3,
  'badge-list': 12,
  metric: 3,
  code: 1,
  quote: 1,
};

/** Blocks whose whole point is a topology. Used by the mode-mismatch warning. */
export const STRUCTURAL: BlockKind[] = ['flow-row', 'sequence', 'ring', 'compare', 'stack', 'hub'];

export const TONE_VAR: Record<Tone, string> = {
  neutral: 'var(--tone-neutral)',
  frontend: 'var(--tone-frontend)',
  backend: 'var(--tone-backend)',
  database: 'var(--tone-database)',
  security: 'var(--tone-security)',
  bus: 'var(--tone-bus)',
  external: 'var(--tone-external)',
  accent: 'var(--accent)',
  danger: 'var(--tone-danger)',
};
