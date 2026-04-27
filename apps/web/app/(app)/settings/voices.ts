export const AVAILABLE_VOICES = [
  {
    id: "aura-2-thalia-en",
    name: "Thalia",
    desc: "Warm, mid-range, evening",
  },
  {
    id: "aura-2-orion-en",
    name: "Orion",
    desc: "Lower, slower, contemplative",
  },
  {
    id: "aura-2-luna-en",
    name: "Luna",
    desc: "Soft, conversational, friendly",
  },
] as const;

export type VoiceId = (typeof AVAILABLE_VOICES)[number]["id"];
