// Positions are one-based and apply to the current day's complete display order.
export function selectionRanges(text, total) {
  if (!text.trim()) return [];
  return text.trim().split(/[,，、]/).map(part => {
    const match = part.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
    if (!match) throw new Error('输入序号或范围，例如 1-10, 15, 20-25');
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > total) throw new Error(`范围应从小到大，且在 1–${total} 内`);
    return [start - 1, end];
  });
}
