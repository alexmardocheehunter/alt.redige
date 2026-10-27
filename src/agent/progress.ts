/**
 * Progression visible de l'agent (AGENT-PROTOCOL.md §3, §4, §6, §7, §9).
 *
 * Ce module ne connaît pas le modèle : il ne fait que transformer des
 * événements de la boucle en événements lisibles par le frontend. Les libellés
 * sont rédigés en français, au présent, sans jargon, et ne contiennent jamais
 * les arguments bruts des outils.
 */
import type {
  AgentEmit,
  PlanStep,
  ProgressPhase,
  SourceItem,
  StepState,
  SuggestionItem,
} from './events.js';

export const PHASE_LABELS: Record<ProgressPhase, string> = {
  understanding: 'Je lis votre demande',
  researching: 'Je consulte le modèle de contrat',
  planning: 'Je prépare les étapes',
  drafting: 'Je rédige le contrat',
  reviewing: 'Je vérifie le document',
  finalizing: 'Je finalise',
};

const CREATE_PLAN: PlanStep[] = [
  { id: 's1', label: 'Identifier le type de contrat' },
  { id: 's2', label: 'Choisir les clauses' },
  { id: 's3', label: 'Rédiger le contrat' },
  { id: 's4', label: 'Vérifier le document' },
];

const EDIT_PLAN: PlanStep[] = [
  { id: 's1', label: 'Reprendre le document' },
  { id: 's2', label: 'Appliquer la modification' },
  { id: 's3', label: 'Vérifier le document' },
];

const LABELS: Record<string, string> = {
  get_template: 'Je consulte le modèle de contrat',
  create_canvas: 'Je rédige le contrat',
  edit_canvas: 'Je modifie le contrat',
  edit_article: 'Je réécris un article',
  insert_table: 'J’insère un tableau',
  insert_list: 'J’insère une liste',
  insert_signature_block: 'Je prépare les signatures',
  compute_date: 'Je calcule la date',
  list_placeholders: 'Je vérifie les champs',
  suggest_next_actions: 'Je prépare la suite',
  ask_user: 'Je prépare une question',
};

export class Progress {
  private currentPhase: ProgressPhase | null = null;
  private planSent = false;
  private readonly stepState = new Map<string, StepState>();
  private readonly toolStartedAt = new Map<string, number>();
  private toolCounter = 0;

  constructor(
    private readonly emit: AgentEmit,
    private readonly editing: boolean,
  ) {}

  /** Phase courante, avec son libellé. */
  phase(phase: ProgressPhase, label?: string): void {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    this.emit('phase', { phase, label: label ?? PHASE_LABELS[phase] });
  }

  /** Envoie le plan une seule fois, puis fait avancer les étapes. */
  plan(): void {
    if (this.planSent) return;
    this.planSent = true;
    this.emit('plan', { steps: this.editing ? EDIT_PLAN : CREATE_PLAN });
  }

  /** Fait avancer une étape ; l'état n'est renvoyé que s'il change. */
  step(id: string, state: StepState, detail?: string): void {
    if (this.stepState.get(id) === state) return;
    this.stepState.set(id, state);
    this.emit('step', {
      id,
      state,
      ...(detail ? { detail: detail.slice(0, 120) } : {}),
    });
  }

  /** Étape en cours pour un identifiant donné. */
  isRunning(id: string): boolean {
    return this.stepState.get(id) === 'running';
  }

  /** Ouvre un outil visible. */
  toolStart(name: string): string {
    this.toolCounter += 1;
    const id = `t${this.toolCounter}`;
    this.toolStartedAt.set(id, Date.now());
    this.emit('tool_start', { id, name, label: LABELS[name] ?? 'Je traite votre demande' });
    return id;
  }

  /** Ferme un outil visible. */
  toolEnd(id: string, name: string, ok: boolean, resultSummary?: string): void {
    const startedAt = this.toolStartedAt.get(id) ?? Date.now();
    this.toolStartedAt.delete(id);
    this.emit('tool_end', {
      id,
      name,
      ok,
      duration_ms: Date.now() - startedAt,
      ...(resultSummary ? { result_summary: resultSummary.slice(0, 160) } : {}),
    });
  }

  /** Références juridiques mobilisées pour le document. */
  sources(items: SourceItem[]): void {
    if (items.length === 0) return;
    this.emit('sources', { items });
  }

  /** Suggestions de suite, en fin de tour. */
  suggestions(items: SuggestionItem[]): void {
    if (items.length === 0) return;
    this.emit('suggestions', { items });
  }
}

/**
 * Suggestions proposées en fin de tour.
 *
 * Elles sont calculées à partir de l'état réel du document (jamais d'une
 * liste statique) et restent courtes : trois libellés de quatre mots maximum.
 */
export function buildSuggestions(options: {
  hasDocument: boolean;
  placeholders: number;
  askedUser: boolean;
  markdown?: string | null;
}): SuggestionItem[] {
  if (options.askedUser) return [];

  const markdown = String(options.markdown ?? '');
  const items: SuggestionItem[] = [];

  if (options.hasDocument) {
    if (options.placeholders > 0) {
      items.push({
        label: 'Compléter les champs',
        message: 'Aide-moi à compléter les champs restants du contrat.',
      });
    }
    if (!/##[^\n]*signature/i.test(markdown)) {
      items.push({
        label: 'Ajouter les signatures',
        message: 'Ajoute un bloc de signatures avec les parties du contrat.',
      });
    }
    if (!/p[ée]nalit[ée]|retard/i.test(markdown)) {
      items.push({
        label: 'Ajouter une pénalité',
        message: 'Ajoute une clause de pénalité de retard.',
      });
    }
    if (!/confidentialit[ée]/i.test(markdown)) {
      items.push({
        label: 'Ajouter la confidentialité',
        message: 'Ajoute une clause de confidentialité.',
      });
    }
    if (items.length < 2) {
      items.push({
        label: 'Simplifier le ton',
        message: 'Rends le ton du contrat plus simple et plus direct.',
      });
    }
  } else {
    items.push(
      {
        label: 'Créer un bail',
        message: 'Je veux rédiger un contrat de bail d’habitation.',
      },
      {
        label: 'Créer un CDI',
        message: 'Je veux rédiger un contrat de travail à durée indéterminée.',
      },
      {
        label: 'Voir les modèles',
        message: 'Montre-moi les types de contrat disponibles.',
      },
    );
  }

  return items.slice(0, 3);
}
