export const SCRIPT_DOMAIN = "script";
export const LEGACY_SCRIPT_ADAPTATION_DOMAIN = "script-adaptation";
export const SCRIPT_ADAPTATION_DOMAIN = SCRIPT_DOMAIN;

export const normalizeContextDomain = (domain = "novel") => (
  domain === LEGACY_SCRIPT_ADAPTATION_DOMAIN ? SCRIPT_DOMAIN : domain
);

export const isScriptDomain = (domain) => normalizeContextDomain(domain) === SCRIPT_DOMAIN;

export const contextDocumentAllowed = ({ targetDomain = "novel", documentDomain = "novel", explicit = false } = {}) => {
  if (explicit) return true;
  return isScriptDomain(targetDomain) || !isScriptDomain(documentDomain);
};
