// Alias matching shared by the project and bot registries.
const WORD_CHAR = /[A-Za-z0-9_-]/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An alias edge that is an ASCII word character must not touch another one; Chinese aliases match anywhere. */
function aliasSource(alias: string): string {
  const before = WORD_CHAR.test(alias[0]) ? '(?<![A-Za-z0-9_-])' : '';
  const after = WORD_CHAR.test(alias.at(-1)!) ? '(?![A-Za-z0-9_-])' : '';
  return `${before}${escapeRegExp(alias)}${after}`;
}

/** "@alias" at the start of a message, with the separators after it. */
export const prefixPattern = (alias: string): RegExp => new RegExp(`^\\s*@${aliasSource(alias)}[\\s:：,，]*`, 'i');
export const mentionPattern = (alias: string): RegExp => new RegExp(aliasSource(alias), 'i');
export const longestFirst = <T extends { alias: string }>(items: T[]): T[] => items.sort((a, b) => b.alias.length - a.alias.length);
