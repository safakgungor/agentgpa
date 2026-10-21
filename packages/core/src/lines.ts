// Line counts for the code an agent wrote: from edit inputs and from patches.

/** The number of lines in a piece of text; a trailing newline does not start a new line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i < text.length - 1) lines++;
  }
  return lines;
}

/** Added and removed lines in a unified diff or an `apply_patch` patch. */
export function patchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}
