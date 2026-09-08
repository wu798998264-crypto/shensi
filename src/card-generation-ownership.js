const clean = (value = "") => String(value ?? "").trim();

/**
 * Records the single generation job that currently owns a whiteboard card.
 * Re-generating a card replaces this lease without changing any saved history.
 */
export const beginCardGenerationOwnership = (ownership = {}, {
  cardId = "",
  generationJobId = "",
  generationType = "",
  connectionId = "",
  model = "",
  startedAt = new Date().toISOString(),
} = {}) => {
  const normalizedCardId = clean(cardId);
  const normalizedJobId = clean(generationJobId);
  if (!normalizedCardId || !normalizedJobId) return { ...(ownership ?? {}) };
  return {
    ...(ownership ?? {}),
    [normalizedCardId]: {
      cardId: normalizedCardId,
      generationJobId: normalizedJobId,
      generationType: clean(generationType),
      connectionId: clean(connectionId),
      model: clean(model),
      startedAt: clean(startedAt),
    },
  };
};

export const cardGenerationOwner = (ownership = {}, cardId = "") => (
  ownership?.[clean(cardId)] ?? null
);

/**
 * A completed job may update only the card/job pair that submitted it. Older
 * completions are retained as recoverable assets, never promoted over the new
 * card result.
 */
export const cardGenerationResultDisposition = (ownership = {}, {
  cardId = "",
  generationJobId = "",
} = {}) => {
  const normalizedCardId = clean(cardId);
  const normalizedJobId = clean(generationJobId);
  const owner = cardGenerationOwner(ownership, normalizedCardId);
  if (!owner) {
    const jobOwner = Object.values(ownership ?? {}).find((candidate) => clean(candidate?.generationJobId) === normalizedJobId) ?? null;
    return jobOwner ? { action: "reject_wrong_card", owner: jobOwner } : { action: "reject_unowned", owner: null };
  }
  if (owner.cardId !== normalizedCardId) return { action: "reject_wrong_card", owner };
  if (owner.generationJobId !== normalizedJobId) return { action: "quarantine", owner };
  return { action: "commit", owner };
};
