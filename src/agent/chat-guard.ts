/**
 * Garde-fou du chat : le contrat ne doit pas être écrit dans la bulle.
 *
 * Constat mesuré en évaluation réelle (scénario 09) : le modèle a écrit
 * 1 127 caractères de contrat dans le chat au lieu du Canvas.
 *
 * Le prompt l'interdit, mais une consigne n'est pas une garantie : le serveur
 * filtre. Le texte est examiné **avant** d'être relayé ; dès qu'il ressemble à
 * un contrat, il n'est pas transmis et un `warning` est émis.
 */

/** Indices d'un contrat : titres d'articles, comparution, formules de clôture. */
const ARTICLE_HEADING = /(?:^|\n)#{1,3}\s*Article\s+\d+/i;
const ARTICLE_INLINE = /\bArticle\s+\d+\s*[–—-]/i;
const PREAMBLE = /entre\s+les\s+soussign[ée]s/i;
const CLOSING = /\b(?:fait\s+[àa]|en\s+deux\s+exemplaires|lu\s+et\s+approuv)/i;
const SIGNATURE_TABLE = /\|\s*le\s+bailleur\s*\|/i;

/** Le texte ressemble-t-il à un contrat ? */
export function isContractLike(text: string): boolean {
  if (!text) return false;
  if (ARTICLE_HEADING.test(text) || ARTICLE_INLINE.test(text)) return true;
  if (PREAMBLE.test(text)) return true;
  if (CLOSING.test(text) && text.length > 200) return true;
  if (SIGNATURE_TABLE.test(text)) return true;
  // Un texte long qui cite beaucoup d'articles.
  const mentions = text.match(/\barticles?\s+\d+/gi);
  if (mentions && mentions.length >= 3) return true;
  return false;
}

export interface ChatGuardState {
  /** Le contrat a été détecté : plus rien n'est relayé dans le chat. */
  tripped: boolean;
  /** Longueur totale du texte produit par le modèle. */
  length: number;
}

export class ChatGuard {
  private buffer = '';
  private state: ChatGuardState = { tripped: false, length: 0 };

  /**
   * Examine le texte avant relais.
   * @returns le fragment à relayer, ou `null` s'il ne doit pas l'être.
   */
  filter(delta: string): string | null {
    this.state.length += delta.length;
    if (this.state.tripped) return null;

    const candidate = this.buffer + delta;
    if (isContractLike(candidate)) {
      this.state.tripped = true;
      return null;
    }

    this.buffer = candidate;
    return delta;
  }

  get tripped(): boolean {
    return this.state.tripped;
  }

  get length(): number {
    return this.state.length;
  }

  /** Résumé à afficher à la place du texte retenu. */
  static summary(): string {
    return 'Le contrat a été écrit dans le document, pas dans le chat.';
  }
}
