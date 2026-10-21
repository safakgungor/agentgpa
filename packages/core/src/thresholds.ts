// The thresholds metrics and signals use, as data. docs/grading.md explains the ones that feed
// grades, archetypes and activities; changing one of those changes the grading version.

export const METRIC_RULES = {
  /** Events of one session with gaps of this many minutes or less form one activity block. */
  blockGapMinutes: 10,
  /** An activity block at least this long is a marathon. */
  marathonMinutes: 360,
  /** A prompt under this many words is short. */
  shortPromptWords: 10,
  /** A prompt with this many words, or a code reference, carries context (Prompt Craft). */
  contextualPromptWords: 8,
  /** Local hours: night runs until nightEndsHour, early from then until earlyEndsHour. */
  nightEndsHour: 5,
  earlyEndsHour: 9,
  /** A session with this many prompts or fewer, active under this many minutes, was abandoned. */
  abandonedMaxPrompts: 2,
  abandonedUnderMinutes: 3,
  /**
   * Sessions with at least planMinPrompts prompts count for Planning. One planned when it used
   * plan mode, asked for a plan in its first planWithinPrompts prompts, or named a plan file.
   */
  planMinPrompts: 3,
  planWithinPrompts: 2,
  /** The same prompt again within this many minutes in one session is a rage repeat (Composure). */
  repeatWithinMinutes: 10,
  /** A caps crisis: this many words and cased letters at least, with this share upper case. */
  capsMinWords: 3,
  capsMinCasedLetters: 10,
  capsUpperShare: 0.7,
  /** Prompt words kept in memory to name the prompts' language, from prompts this long. */
  languageSampleChars: 50_000,
  languageMinWords: 3,
  /** Each prompt's own language is named from its first characters, for prompts this long. */
  promptLanguageMinWords: 8,
  promptLanguageChars: 240,
} as const;

export const SIGNAL_RULES = {
  /** Burstiness: the share of prompts on the busiest tenth of active days. */
  burstTopDays: 0.1,
  /** A break of this many days or more before an active day is a comeback. */
  comebackDays: 7,
  /** Local hours that count as lunch. */
  lunchHours: [12, 13],
  /** Sunday night starts at this local hour; Friday deploys count from this one. */
  sundayNightFromHour: 18,
  fridayDeployFromHour: 15,
  /** This many caps, swear or correction prompts within meltdownMinutes are a meltdown. */
  meltdownPrompts: 3,
  meltdownMinutes: 10,
  /** The most repeated prompt counts when it has this many words and came up this often. */
  mostRepeatedMinWords: 2,
  mostRepeatedMinCount: 3,
  /** New Year: a prompt this many minutes or less either side of midnight on Dec 31. */
  newYearMinutes: 30,
  /** A language counts as used with this share of the prompts long enough to tell. */
  languageUsedShare: 0.05,
  /** Glow up compares the first and the last windowDays of a long enough, busy enough period. */
  glowUp: { windowDays: 30, minPeriodDays: 60, minActiveDays: 20, minPromptsPerWindow: 20 },
} as const;

/** The file checks the CLI runs before the skeleton is built. */
export const FORENSIC_RULES = {
  /**
   * A session file created this long after its newest event was written after the fact (or
   * copied from another machine). Change times say nothing: tools rewrite old files.
   */
  createdAfterLastEventMinutes: 60,
} as const;

/** The sample of hashed provider message ids that lets the server catch a reused transcript. */
export const FINGERPRINT_RULES = {
  /** Hex characters kept of each SHA-256. */
  hexChars: 16,
  /** Only hashes that start with this are sent: a sample the same on every machine. */
  prefix: '00',
  max: 512,
} as const;

export const REDACTION_RULES = {
  /** A token of 20 or more letters and digits this close to random (bits per character) is a secret. */
  minEntropy: 3.8,
  /** Phone numbers have this many digits. */
  minPhoneDigits: 9,
  maxPhoneDigits: 15,
  /** Project and account names shorter than this are left alone (they match ordinary words). */
  minNameLength: 3,
} as const;

export const QUOTE_RULES = {
  /** Characters a quote may have once masked (a mask counts as its letters). */
  maxLength: 120,
  minWords: 2,
  /** Heat of a salty prompt: its swears, its caps share, its "!" marks and being short. */
  saltSwearWeight: 3,
  saltCapsWeight: 2,
  saltShortWords: 8,
  /** Cryptic: short, and at least this share of its words point at nothing in particular. */
  crypticMinWords: 3,
  crypticMaxWords: 12,
  crypticMinVagueShare: 0.4,
  crypticCount: 2,
} as const;

export const PACKET_RULES = {
  /** Prompts in a deep read packet, sampled across tools and weeks. */
  maxPrompts: 600,
  /** Each prompt is cut to this many characters once redacted. */
  promptChars: 280,
  /** Longer prompts are pasted blobs, not something the user typed. */
  maxSourceChars: 2000,
  minWords: 3,
  maxSessions: 5000,
  /** Project folder names in a packet, each cut to this many characters once cleaned. */
  maxProjects: 200,
  projectChars: 60,
} as const;
