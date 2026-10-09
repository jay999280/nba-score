/**
 * The localStorage keys named by the PRD §29, plus the one dismissal the
 * install prompt records so it never nags twice.
 */
export const STORAGE_KEYS = {
  favorites: "favoriteTeams",
  theme: "theme",
  spoiler: "spoilerMode",
  installDismissed: "installPromptDismissed",
} as const;
