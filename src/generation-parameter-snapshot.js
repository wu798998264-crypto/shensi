// Only card-level options belong in a portable generation snapshot. Never
// copy credentials, endpoints or an arbitrary settings object into a card.
const PARAMETER_FIELDS = [
  'aspectRatio', 'quality', 'resolution', 'duration', 'generationMode',
  'generateAudio', 'background', 'imageCount', 'videoCount', 'audioType',
  'scene', 'voiceId', 'language', 'speed', 'format', 'sampleRate',
];

export const generationParameterSnapshot = (source = {}) => Object.fromEntries(
  PARAMETER_FIELDS.flatMap((field) => {
    const value = source?.[field];
    if (typeof value === 'boolean') return [[field, value]];
    if (typeof value === 'number' && Number.isFinite(value)) return [[field, value]];
    if (typeof value === 'string' && value.trim()) return [[field, value.trim().slice(0, 240)]];
    return [];
  }),
);
