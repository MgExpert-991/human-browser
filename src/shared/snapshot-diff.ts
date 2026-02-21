interface DiffEdit {
  type: 'equal' | 'insert' | 'delete';
  line: string;
}

interface SnapshotDiffResult {
  diff: string;
  additions: number;
  removals: number;
  unchanged: number;
  changed: boolean;
}

function myersDiff(before: string[], after: string[]): DiffEdit[] {
  const n = before.length;
  const m = after.length;
  const max = n + m;

  if (max === 0) {
    return [];
  }

  if (n === m) {
    let identical = true;
    for (let i = 0; i < n; i += 1) {
      if (before[i] !== after[i]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      return before.map((line) => ({ type: 'equal', line }));
    }
  }

  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize);
  v.fill(-1);
  const trace: Int32Array[] = [];

  v[max + 1] = 0;

  for (let d = 0; d <= max; d += 1) {
    trace.push(new Int32Array(v));

    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x: number;

      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1] ?? -1;
      } else {
        x = (v[idx - 1] ?? -1) + 1;
      }

      let y = x - k;

      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }

      v[idx] = x;

      if (x >= n && y >= m) {
        return buildEditScript(trace, before, after, max);
      }
    }
  }

  return buildEditScript(trace, before, after, max);
}

function buildEditScript(trace: Int32Array[], before: string[], after: string[], max: number): DiffEdit[] {
  const edits: DiffEdit[] = [];
  let x = before.length;
  let y = after.length;

  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const idx = k + max;

    let prevK: number;
    if (k === -d || (k !== d && (v[idx - 1] ?? -1) < (v[idx + 1] ?? -1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevIdx = prevK + max;
    const prevX = v[prevIdx] ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      edits.push({
        type: 'equal',
        line: before[x] as string,
      });
    }

    if (x === prevX) {
      y -= 1;
      edits.push({
        type: 'insert',
        line: after[y] as string,
      });
    } else {
      x -= 1;
      edits.push({
        type: 'delete',
        line: before[x] as string,
      });
    }
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({
      type: 'equal',
      line: before[x] as string,
    });
  }

  edits.reverse();
  return edits;
}

export function diffSnapshotText(beforeText: string, afterText: string): SnapshotDiffResult {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');
  const edits = myersDiff(beforeLines, afterLines);

  let additions = 0;
  let removals = 0;
  let unchanged = 0;
  const diffLines: string[] = [];

  for (const edit of edits) {
    if (edit.type === 'equal') {
      unchanged += 1;
      diffLines.push(`  ${edit.line}`);
      continue;
    }
    if (edit.type === 'insert') {
      additions += 1;
      diffLines.push(`+ ${edit.line}`);
      continue;
    }
    removals += 1;
    diffLines.push(`- ${edit.line}`);
  }

  return {
    diff: diffLines.join('\n'),
    additions,
    removals,
    unchanged,
    changed: additions > 0 || removals > 0,
  };
}
