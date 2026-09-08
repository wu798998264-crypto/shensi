export const CHAT_COMPOSER_HEIGHT_DEFAULT = 136;

export const CHAT_COMPOSER_HEIGHT_LIMITS = Object.freeze({
  min: 112,
  max: 520,
  reservedPanelHeight: 144,
});

const numberValue = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

export const chatComposerHeightRange = ({
  panelHeight,
  limits = CHAT_COMPOSER_HEIGHT_LIMITS,
} = {}) => {
  const min = Math.max(1, Math.round(numberValue(limits?.min, CHAT_COMPOSER_HEIGHT_LIMITS.min)));
  const configuredMax = Math.max(min, Math.round(numberValue(limits?.max, CHAT_COMPOSER_HEIGHT_LIMITS.max)));
  const reservedPanelHeight = Math.max(0, Math.round(numberValue(
    limits?.reservedPanelHeight,
    CHAT_COMPOSER_HEIGHT_LIMITS.reservedPanelHeight,
  )));
  const availableHeight = Math.max(0, Math.round(numberValue(panelHeight, configuredMax + reservedPanelHeight)));
  return {
    min,
    max: Math.max(min, Math.min(configuredMax, availableHeight - reservedPanelHeight)),
  };
};

export const clampChatComposerHeight = (height, options = {}) => {
  const range = chatComposerHeightRange(options);
  return Math.round(clamp(numberValue(height, CHAT_COMPOSER_HEIGHT_DEFAULT), range.min, range.max));
};

export const resizeChatComposerHeight = ({
  startHeight,
  startY,
  currentY,
  panelHeight,
  limits = CHAT_COMPOSER_HEIGHT_LIMITS,
} = {}) => clampChatComposerHeight(
  numberValue(startHeight, CHAT_COMPOSER_HEIGHT_DEFAULT)
    + numberValue(startY, 0)
    - numberValue(currentY, 0),
  { panelHeight, limits },
);
