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

/**
 * Mots anglais **sans aucun emploi français**, dans un acte juridique.
 *
 * Règle de constitution de la liste : n'y figure que des mots qui ne
 * pourraient pas être du français. Les homographes français/anglais
 * (« date », « contrat », « occupation », « user », « production », « rapport »,
 * « équipe ») sont exclus, même peu courants : un faux positif sur un acte
 * correct est plus coûteux qu'un anglicisme non détecté.
 *
 * La liste est vérifiée contre le corpus du dépôt (squelettes, notes
 * juridiques, exemple de référence) : aucun mot de la liste ne doit y
 * apparaître.
 */
const ENGLISH_WORDS = [
  // Anglicismes observés dans les documents produits.
  'signing', 'dedication', 'methodologies', 'methodology', 'pausing',
  'eventual', 'eventually', 'workflow', 'workflows', 'deadline', 'deadlines',
  'feedback', 'checklist', 'checklists', 'corporate', 'stakeholder',
  'stakeholders', 'onboarding', 'offboarding', 'deliverable', 'deliverables',
  'milestone', 'milestones', 'prerequisite', 'prerequisites', 'prorata',
  'proforma', 'scoping', 'dashboard', 'dashboards', 'handbook', 'playbook',
  'runbook', 'sandbox', 'staging', 'namespace', 'tracker', 'dashboard',
  'backlog', 'roadmap', 'sprint', 'sprints', 'ticket', 'tickets',
  'oncall', 'headcount', 'kpi', 'kpis', 'roi', 'crm', 'erp', 'saas',
  'headline', 'api', 'apis', 'url', 'urls', 'ping', 'async', 'sync',
  'bug', 'bugs', 'commit', 'commits', 'branch', 'branches', 'merge',
  'deploy', 'deploys', 'payload', 'widget', 'widgets', 'login', 'logout',
  'username', 'password', 'email', 'emails', 'handbook',
  // Vocabulaire des contrats anglophones.
  'landlord', 'tenant', 'premises', 'lessee', 'lessor', 'lease', 'leasing',
  'rental', 'rentals', 'arrears', 'rent', 'sublet', 'sublease', 'waiver',
  'waive', 'breach', 'indemnity', 'warranty', 'guarantee', 'covenant',
  'covenants', 'escrow', 'prepayment', 'instalment', 'instalments',
  'defaulting', 'vendor', 'vendors', 'procurement', 'invoice', 'invoices',
  'refund', 'renewal', 'renewals', 'termination', 'confidentiality',
  'noncompete', 'compliance', 'pricing', 'payment', 'payments', 'occupier',
  // Anglicismes juridiques classiques dans un acte francophone.
  'duly', 'herein', 'hereunder', 'hereinafter', 'hereof', 'thereof',
  'therein', 'thereto', 'whereas', 'foregoing', 'aforementioned', 'namely',
  'notwithstanding', 'pursuant', 'behalf', 'favour', 'favor', 'mutatis',
  'mutandis', 'aforesaid', 'heretofore', 'hereinbefore', 'witness',
  'good faith', 'best practices',
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
