/**
 * The reserved names, in one place.
 *
 * This check existed twice — once for the shipping presets and once for the
 * axis library — written independently months apart. Both were first written as
 * substring matches, and both rejected the ordinary word *portrait* because
 * **Portra** is inside it. The same trap as the commit guard rejecting the
 * project instructions filename for containing a forbidden word.
 *
 * Two copies of a rule are two chances to get it wrong and two places to fix
 * it, and the second copy did not benefit from the first one's scar. So: one
 * list, word-bounded, used by both.
 *
 * Word boundaries rather than an allow-list of innocent words, because an
 * allow-list is a judgement someone has to maintain and a boundary is not.
 */

const RESERVED = [
  'leica',
  'contax',
  'yashica',
  'olympus',
  'holga',
  'lomo',
  'portra',
  'velvia',
  'provia',
  'ektar',
  'cinestill',
  'kodak',
  'fuji',
  'fujifilm',
  'ilford',
  'canon',
  'nikon',
  'hasselblad',
  'polaroid',
  'instax',
  'tri-?x',
]

export const TRADEMARK_PATTERN = new RegExp(`\\b(${RESERVED.join('|')})\\b`, 'i')

/** The reserved name a string borrows, or `null`. */
export function borrowedTrademark(text: string): string | null {
  return TRADEMARK_PATTERN.exec(text)?.[0] ?? null
}
