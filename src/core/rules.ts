import type { Rule } from './types';

/**
 * Default classification-label vocabulary.
 *
 * Selection criteria: words/phrases that are used as *labels* in headers, footers, watermarks and stamps.
 * Deliberately excluded because they are too common in ordinary prose: "Internal", "Private", "General", "Public",
 * "密" (would hit 密碼/密切), "Limited".
 * Longer phrases win over shorter ones when they overlap ("Strictly Confidential" beats "Confidential").
 */
const EN = [
  'Strictly Confidential',
  'Highly Confidential',
  'Company Confidential',
  'Private and Confidential',
  'Privileged and Confidential',
  'Personal and Confidential',
  'Proprietary and Confidential',
  'Confidential',
  'Proprietary',
  'For Internal Use Only',
  'Internal Use Only',
  'Internal Use',
  'Internal Only',
  'Restricted',
  'Highly Restricted',
  'Sensitive',
  'Highly Sensitive',
  'Top Secret',
  'Trade Secret',
  'Secret',
  'Classified',
  'Do Not Distribute',
  'Do Not Forward',
  'Do Not Copy',
  'Not for Distribution',
  'Not for External Distribution',
  'Not for Public Release',
  'For Official Use Only',
  'FOUO',
  'Need to Know',
  'Attorney-Client Privileged',
];

const ZH_HANT = [
  '極機密',
  '絕對機密',
  '最高機密',
  '公司機密',
  '機密文件',
  '機密資料',
  '機密',
  '密件',
  '限閱文件',
  '限閱',
  '僅供內部使用',
  '限內部使用',
  '內部使用',
  '內部文件',
  '內部資料',
  '營業秘密',
  '敏感資訊',
  '敏感資料',
  '機敏',
  '敏感',
  '不得外流',
  '禁止外流',
  '請勿外流',
  '請勿外傳',
  '不得外傳',
  '禁止轉發',
  '保密',
];

const ZH_HANS = ['绝密', '机密文件', '机密', '仅供内部使用', '内部使用', '内部资料', '内部文件', '公司机密', '商业秘密', '限阅', '敏感信息', '敏感数据', '不得外传', '请勿外传', '禁止转发'];

const JA = ['関係者外秘', '社外秘', '部外秘', '極秘', '厳秘', '社内限り', '社内限定', '取扱注意', '機密情報', '秘密'];

const KO = ['대외비', '극비', '기밀'];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

function mk(lang: string, words: string[]): Rule[] {
  return words.map((pattern) => ({
    id: `${lang}:${slug(pattern)}`,
    pattern,
    isRegex: false,
    wholeWord: true, // ignored automatically for CJK patterns
    caseSensitive: false,
    enabled: true,
    category: 'label' as const,
  }));
}

export const DEFAULT_RULES: readonly Rule[] = Object.freeze([
  ...mk('en', EN),
  ...mk('zh-Hant', ZH_HANT),
  ...mk('zh-Hans', ZH_HANS),
  ...mk('ja', JA),
  ...mk('ko', KO),
]);

/** Create a user rule (company name, project code name, custom regex …). */
export function userRule(pattern: string, opts: Partial<Omit<Rule, 'id' | 'pattern'>> = {}): Rule {
  return {
    id: `user:${opts.isRegex ? 're:' : ''}${slug(pattern) || 'x'}:${hash(pattern)}`,
    pattern,
    isRegex: false,
    wholeWord: true,
    caseSensitive: false,
    enabled: true,
    category: 'custom',
    ...opts,
  };
}

/** Small stable string hash (FNV-1a, base36) — used for ids, not security. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
