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
  {
    id: "aura-2-aries-en",
    name: "Aries",
    desc: "Masculine, warm, energetic, caring",
  },
  {
    id: "aura-2-draco-en",
    name: "Draco",
    desc: "Masculine, measured, grounded",
  },
  {
    id: "aura-2-iris-en",
    name: "Iris",
    desc: "Feminine, cheerful, positive, approachable",
  },
] as const;

export type VoiceId = (typeof AVAILABLE_VOICES)[number]["id"];
