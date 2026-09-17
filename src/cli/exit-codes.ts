/** Process exit codes; stable so Claude and scripts can branch on them. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  jevUnavailable: 3,
  codexUnavailable: 4,
  workerFailed: 5,
} as const;
