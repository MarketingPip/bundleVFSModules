'use strict';

/**
 * Universal table renderer (Node.js + browser)
 * 
 * Usage:
 *   import table from './table.js'; // ESM
 *   const output = table(['Name','Age'], [['Alice','Bob'], ['23','30']]);
 *   console.log(output);
 */

// ─── Unicode table characters ────────────────────────────────────────────────
const tableChars = {
  middleMiddle: '─',
  rowMiddle: '┼',
  topRight: '┐',
  topLeft: '┌',
  leftMiddle: '├',
  topMiddle: '┬',
  bottomRight: '┘',
  bottomLeft: '└',
  bottomMiddle: '┴',
  rightMiddle: '┤',
  left: '│ ',
  right: ' │',
  middle: ' │ ',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

// Approximate string width (accounts for basic fullwidth characters)
const getStringWidth = (str) => {
  if (typeof str !== 'string') str = String(str);
  // simple approximation: 1 for normal, 2 for wide unicode (CJK, emojis)
  return [...str].reduce((w, ch) => {
    const code = ch.charCodeAt(0);
    return w + ((code > 0x1f && code < 0x7f) ? 1 : 2);
  }, 0);
};

const renderRow = (row, columnWidths) => {
  let out = tableChars.left;
  for (let i = 0; i < row.length; i++) {
    const cell = String(row[i] ?? '');
    const len = getStringWidth(cell);
    const needed = columnWidths[i] - len;
    out += cell + ' '.repeat(Math.ceil(needed));
    if (i !== row.length - 1)
      out += tableChars.middle;
  }
  out += tableChars.right;
  return out;
};

// ─── Main table function ────────────────────────────────────────────────────

export const table = (head, columns) => {
  const rows = [];
  const columnWidths = head.map((h) => getStringWidth(h));
  const longestColumn = Math.max(...columns.map(a => a.length));

  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longestColumn; j++) {
      if (!rows[j]) rows[j] = [];
      const value = column.hasOwnProperty(j) ? column[j] : '';
      rows[j][i] = value;
      columnWidths[i] = Math.max(columnWidths[i] || 0, getStringWidth(value));
    }
  }

  const divider = columnWidths.map(i => tableChars.middleMiddle.repeat(i + 2));

  let result = tableChars.topLeft +
               divider.join(tableChars.topMiddle) +
               tableChars.topRight + '\n' +
               renderRow(head, columnWidths) + '\n' +
               tableChars.leftMiddle +
               divider.join(tableChars.rowMiddle) +
               tableChars.rightMiddle + '\n';

  for (const row of rows)
    result += `${renderRow(row, columnWidths)}\n`;

  result += tableChars.bottomLeft +
            divider.join(tableChars.bottomMiddle) +
            tableChars.bottomRight;

  return result;
};
