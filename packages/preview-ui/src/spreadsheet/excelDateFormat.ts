/** Built-in short date (14) and date-time (22) follow the system locale in Excel/WPS; ExcelJS reports the US codes. */
const LOCALE_DATE_FORMATS: Record<string, string> = {
  'mm-dd-yy': 'yyyy/m/d',
  'm/d/yy "h":mm': 'yyyy/m/d h:mm',
  'm/d/yy h:mm': 'yyyy/m/d h:mm',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CN_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']; // i18n-ignore

type Token = { kind: 'literal'; text: string } | { kind: 'part'; letter: string; size: number } | { kind: 'ampm'; am: string; pm: string } | { kind: 'fraction'; size: number };

/** Render an ExcelJS date value (wall time stored in UTC fields) with the cell's number format code. */
export function formatExcelDate(date: Date, numFmt: string | undefined): string {
  if (Number.isNaN(date.getTime())) return '';
  const code = numFmt && numFmt !== 'General' ? LOCALE_DATE_FORMATS[numFmt] ?? numFmt : defaultFormat(date);
  const tokens = tokenize(code);
  if (!tokens.some(token => token.kind === 'part')) return formatExcelDate(date, defaultFormat(date));
  const twelveHour = tokens.some(token => token.kind === 'ampm');
  const pad = (value: number, size: number) => String(value).padStart(size, '0');
  return tokens.map((token, index) => {
    if (token.kind === 'literal') return token.text;
    if (token.kind === 'ampm') return date.getUTCHours() < 12 ? token.am : token.pm;
    if (token.kind === 'fraction') return pad(date.getUTCMilliseconds(), 3).slice(0, token.size);
    const { letter, size } = token;
    if (letter === 'y' || letter === 'e') return size <= 2 && letter === 'y' ? pad(date.getUTCFullYear() % 100, 2) : String(date.getUTCFullYear());
    if (letter === 'd') return size <= 2 ? pad(date.getUTCDate(), size) : size === 3 ? WEEKDAYS[date.getUTCDay()].slice(0, 3) : WEEKDAYS[date.getUTCDay()];
    if (letter === 'a') return size === 3 ? CN_WEEKDAYS[date.getUTCDay()] : `星期${CN_WEEKDAYS[date.getUTCDay()]}`; // i18n-ignore
    if (letter === 'h') return pad(twelveHour ? (date.getUTCHours() % 12 || 12) : date.getUTCHours(), Math.min(size, 2));
    if (letter === 's') return pad(date.getUTCSeconds(), Math.min(size, 2));
    if (size <= 2 && isMinute(tokens, index)) return pad(date.getUTCMinutes(), size);
    const month = date.getUTCMonth();
    return size <= 2 ? pad(month + 1, size) : size === 3 ? MONTHS[month].slice(0, 3) : size === 4 ? MONTHS[month] : MONTHS[month][0];
  }).join('');
}

function defaultFormat(date: Date): string {
  return date.getUTCHours() || date.getUTCMinutes() || date.getUTCSeconds() ? 'yyyy/m/d h:mm:ss' : 'yyyy/m/d';
}

/** `m` means minutes right after an hour or right before a second; otherwise it is the month. */
function isMinute(tokens: Token[], index: number): boolean {
  const neighbour = (step: number) => {
    for (let i = index + step; i >= 0 && i < tokens.length; i += step) {
      const token = tokens[i];
      if (token.kind === 'part') return token.letter;
    }
    return undefined;
  };
  return neighbour(-1) === 'h' || neighbour(1) === 's';
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const literal = (text: string) => { const last = tokens[tokens.length - 1]; if (last?.kind === 'literal') last.text += text; else tokens.push({ kind: 'literal', text }); };
  for (let i = 0; i < code.length;) {
    const rest = code.slice(i);
    const char = code[i];
    if (char === ';') break;
    if (char === '"') { const end = code.indexOf('"', i + 1); literal(code.slice(i + 1, end < 0 ? code.length : end)); i = end < 0 ? code.length : end + 1; continue; }
    if (char === '\\') { literal(code[i + 1] ?? ''); i += 2; continue; }
    if (char === '_') { literal(' '); i += 2; continue; }
    if (char === '*') { i += 2; continue; }
    if (char === '@') { i += 1; continue; }
    if (char === '[') {
      const end = code.indexOf(']', i);
      const inner = end < 0 ? '' : code.slice(i + 1, end).toLowerCase();
      if (/^(h+|m+|s+)$/.test(inner)) tokens.push({ kind: 'part', letter: inner[0], size: inner.length });
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    const ampm = /^(AM\/PM|A\/P|上午\/下午)/i.exec(rest);
    if (ampm) {
      const [am, pm] = ampm[1].toUpperCase() === 'A/P' ? ['A', 'P'] : ampm[1].startsWith('上') ? ['上午', '下午'] : ['AM', 'PM']; // i18n-ignore
      tokens.push({ kind: 'ampm', am, pm }); i += ampm[1].length; continue;
    }
    const fraction = /^\.(0+)/.exec(rest);
    const previous = tokens[tokens.length - 1];
    if (fraction && previous?.kind === 'part' && previous.letter === 's') { tokens.push({ kind: 'fraction', size: fraction[1].length }); i += fraction[0].length; continue; }
    const lower = char.toLowerCase();
    if ('ymdhsea'.includes(lower) && !(lower === 'a' && !/^aaa/i.test(rest))) {
      let size = 1;
      while (code[i + size]?.toLowerCase() === lower) size += 1;
      tokens.push({ kind: 'part', letter: lower, size });
      i += size;
      continue;
    }
    literal(char);
    i += 1;
  }
  return tokens;
}
