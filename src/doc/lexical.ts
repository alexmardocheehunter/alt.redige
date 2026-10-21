/**
 * Garde-fou lexical : un acte de droit est rédigé en français.
 *
 * Les modèles à raisonnement glissent régulièrement des mots anglais dans le
 * texte (« dedication », « pausing », « methodologies »). La liste ci-dessous
 * ne contient que des mots **qui n'existent pas en français usuel** : un
 * homographe français/anglais (« date », « contrat », « occupation ») n'y
 * figure jamais, pour ne pas signaler un mot légitime.
 *
 * C'est une liste noire, pas une détection « mot inconnu » : le risque de
 * faux positif doit rester nul sur un acte bien rédigé.
 */

/** Mots anglais sans équivalent français usuel dans un acte juridique. */
const ENGLISH_WORDS = [
  // Anglicismes observés dans les documents produits.
  'signing', 'dedication', 'methodologies', 'methodology', 'pausing', 'eventual',
  'eventually', 'workflow', 'workflows', 'deadline', 'deadlines', 'feedback',
  'checklist', 'checklists', 'corporate', 'stakeholder', 'stakeholders',
  'onboarding', 'offboarding', 'deliverable', 'deliverables', 'milestone',
  'milestones', 'prerequisite', 'prerequisites', 'prorata', 'proforma',
  // Vocabulaire courant des contrats anglophones.
  'landlord', 'tenant', 'premises', 'lessee', 'lessor', 'lease', 'leasing',
  'rental', 'rentals', 'arrears', 'rent', 'sublet', 'sublease', 'waiver',
  'waive', 'breach', 'indemnity', 'warranty', 'guarantee', 'covenant',
  'covenants', 'escrow', 'prepayment', 'instalment', 'instalments',
  'defaulting', 'termination', 'renewal', 'renewals', 'confidentiality',
  'noncompete', 'procurement', 'occupier', 'invoice', 'invoices', 'refund',
  'payment', 'payments', 'vendor', 'vendors', 'compliance', 'pricing',
  'user', 'users', 'login', 'logout', 'username', 'password', 'email',
  'emails', 'url', 'urls', 'ping', 'async', 'sync', 'bug', 'bugs', 'commit',
  'commits', 'branch', 'branches', 'merge', 'deploy', 'deploys', 'build',
  'builds', 'release', 'releases', 'ticket', 'tickets', 'sprint', 'sprints',
  'backlog', 'roadmap', 'owner', 'owners', 'team', 'teams', 'manager',
  'managers', 'management', 'scoping', 'tracker', 'tracking', 'oncall',
  'dashboard', 'dashboards', 'widget', 'widgets', 'payload', 'cache',
  'proxy', 'server', 'servers', 'client', 'clients', 'database', 'databases',
  'meeting', 'meetings', 'handbook', 'playbook', 'runbook', 'sandbox',
  'staging', 'production', 'namespace', 'token', 'tokens', 'layout',
  'layouts', 'folder', 'folders', 'asset', 'assets', 'graph', 'graphs',
  'chart', 'charts', 'widget', 'header', 'footer', 'headline', 'kpi',
  'roi', 'kpis', 'lead', 'leads', 'crm', 'erp', 'saas', 'api', 'apis',
  // Anglicismes juridiques classiques dans un acte francophone.
  'duly', 'herein', 'hereunder', 'hereinafter', 'hereof', 'thereof',
  'therein', 'thereto', 'whereas', 'foregoing', 'aforementioned', 'namely',
  'notwithstanding', 'pursuant', 'behalf', 'favour', 'favor', 'mutatis',
  'mutandis', 'force majeure', 'best', 'worst',
];

const WORD_SET = new Set(ENGLISH_WORDS.map((word) => word.toLowerCase()));

/** Minuscules, sans accents. */
function normalizeWord(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Mots anglais détectés dans un texte.
 *
 * @param text        texte à analyser (document ou message de chat)
 * @param extraWords  mots supplémentaires à surveiller (configurables)
 */
export function findEnglishWords(text: string, extraWords: string[] = []): string[] {
  const extra = new Set(extraWords.map((word) => normalizeWord(word)));
  const found = new Set<string>();

  for (const raw of text.split(/[^\p{L}\p{N}'’-]+/u)) {
    if (!raw) continue;
    const word = normalizeWord(raw);
    if (word.length < 3) continue;
    if (WORD_SET.has(word) || extra.has(word)) found.add(raw);
  }

  return [...found].sort();
}

/** Vrai si le texte contient au moins un mot anglais de la liste. */
export function containsEnglishWord(text: string, extraWords: string[] = []): boolean {
  return findEnglishWords(text, extraWords).length > 0;
}
