/**
 * Glyph name → Unicode for names used by /Differences arrays.
 * Covers every WinAnsiEncoding glyph name (via its cp1252 code) plus common extras; `uniXXXX` / `uXXXX` names are
 * handled algorithmically in fonts.ts.
 */
const WINANSI_NAMES: Array<[number, string]> = [];
const ASCII =
  'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde';
ASCII.split(' ').forEach((n, i) => WINANSI_NAMES.push([32 + i, n]));
const HIGH =
  'Euro _ quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE _ Zcaron _ _ quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe _ zcaron Ydieresis space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis';
HIGH.split(' ').forEach((n, i) => n !== '_' && WINANSI_NAMES.push([128 + i, n]));

const cp1252 = new TextDecoder('windows-1252');

export const GLYPH_TO_UNICODE: Map<string, string> = new Map(WINANSI_NAMES.map(([code, name]) => [name, cp1252.decode(new Uint8Array([code]))]));

for (const [n, u] of Object.entries({
  space: ' ',
  nbspace: ' ',
  sfthyphen: '­',
  fi: 'fi',
  fl: 'fl',
  ff: 'ff',
  ffi: 'ffi',
  ffl: 'ffl',
  dotlessi: 'ı',
  Lslash: 'Ł',
  lslash: 'ł',
  minus: '−',
  fraction: '⁄',
  quoteright: '’',
  quoteleft: '‘',
  hyphenminus: '-',
  ring: '˚',
  caron: 'ˇ',
  breve: '˘',
  dotaccent: '˙',
  hungarumlaut: '˝',
  ogonek: '˛',
  Delta: 'Δ',
  Omega: 'Ω',
  pi: 'π',
  mu: 'µ',
  lozenge: '◊',
  notequal: '≠',
  lessequal: '≤',
  greaterequal: '≥',
  infinity: '∞',
  summation: '∑',
  product: '∏',
  integral: '∫',
  radical: '√',
  approxequal: '≈',
  partialdiff: '∂',
  apple: '',
})) GLYPH_TO_UNICODE.set(n, u);
