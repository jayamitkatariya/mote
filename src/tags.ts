const TAG_PATTERN = /(?:^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_-]{1,32})(?![\p{L}\p{N}_-])/gu;

export const MAX_TAGS = 12;

export function parseTags(body: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(TAG_PATTERN)) {
    const tag = match[1].toLowerCase();
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

export function allTags(tagsLists: string[][]): string[] {
  const counts = new Map<string, number>();
  for (const tags of tagsLists) {
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}
