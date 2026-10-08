// A small XML reader for the SVG import. core/ has no DOM — the unit tests run in Node,
// where there is no DOMParser — and SVG needs little of XML: elements, attributes, text,
// CDATA, comments, the predefined and character entities, and the entities a DOCTYPE
// declares (Illustrator writes its namespaces as entities).

export interface XmlElement {
  // As written, prefix and all: 'svg', 'inkscape:namedview'.
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  parent: XmlElement | null;
}

export type XmlNode = XmlElement | string;

export class XmlError extends Error {}

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const NAME = /[A-Za-z_:\u00C0-\uFFFF][-.\w:\u00B7\u00C0-\uFFFF]*/y;

// The document's root element; anything that is not well-formed is an error with its line.
export function parseXml(text: string): XmlElement {
  const entities: Record<string, string> = { ...PREDEFINED };
  let i = 0;
  const line = (at: number) => text.slice(0, at).split('\n').length;
  const fail = (what: string, at = i): never => {
    throw new XmlError(`строка ${line(at)}: ${what}`);
  };

  const decode = (s: string, at: number): string =>
    s.indexOf('&') < 0
      ? s
      : s.replace(/&(#x[0-9a-f]+|#[0-9]+|[A-Za-z_][-.\w]*);/gi, (_, ref: string) => {
          if (ref[0] === '#') {
            const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fail(`неверный символ &${ref};`, at);
          }
          const value = entities[ref];
          return value ?? fail(`неизвестная сущность &${ref};`, at);
        });

  const name = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(text);
    if (!m) fail('ожидалось имя');
    i += m![0].length;
    return m![0];
  };
  const spaces = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i]!)) i++;
  };
  const skipPast = (end: string, what: string): number => {
    const at = text.indexOf(end, i);
    if (at < 0) fail(`${what} не закрыт`);
    const start = i;
    i = at + end.length;
    return start;
  };

  // <!DOCTYPE svg PUBLIC "…" "…" [ <!ENTITY name "value"> … ]>
  const doctype = () => {
    i += '<!DOCTYPE'.length;
    while (i < text.length && text[i] !== '>' && text[i] !== '[') {
      if (text[i] === '"' || text[i] === "'") i = text.indexOf(text[i]!, i + 1) + 1 || fail('DOCTYPE не закрыт');
      else i++;
    }
    if (text[i] === '[') {
      i++;
      for (;;) {
        spaces();
        if (text[i] === ']') break;
        if (text.startsWith('<!ENTITY', i)) {
          i += '<!ENTITY'.length;
          spaces();
          const parameter = text[i] === '%';
          if (parameter) {
            i++;
            spaces();
          }
          const key = name();
          spaces();
          const q = text[i];
          if (q === '"' || q === "'") {
            const end = text.indexOf(q, i + 1);
            if (end < 0) fail('сущность не закрыта');
            if (!parameter) entities[key] = decode(text.slice(i + 1, end), i);
            i = end + 1;
          }
          skipPast('>', 'объявление сущности');
        } else if (text.startsWith('<!--', i)) skipPast('-->', 'комментарий');
        else if (text.startsWith('<?', i)) skipPast('?>', 'инструкция');
        else if (text[i] === '<') skipPast('>', 'объявление');
        else if (i >= text.length) fail('DOCTYPE не закрыт');
        else i++;
      }
      i++;
      spaces();
    }
    if (text[i] !== '>') fail('DOCTYPE не закрыт');
    i++;
  };

  // Comments, processing instructions and the DOCTYPE, before or after the root.
  const misc = (): boolean => {
    spaces();
    if (text.startsWith('<?', i)) skipPast('?>', 'инструкция');
    else if (text.startsWith('<!--', i)) skipPast('-->', 'комментарий');
    else if (text.startsWith('<!DOCTYPE', i)) doctype();
    else return false;
    return true;
  };

  const element = (parent: XmlElement | null): XmlElement => {
    const start = i;
    i++; // <
    const el: XmlElement = { name: name(), attrs: {}, children: [], parent };
    for (;;) {
      spaces();
      if (text.startsWith('/>', i)) {
        i += 2;
        return el;
      }
      if (text[i] === '>') {
        i++;
        break;
      }
      if (i >= text.length) fail(`<${el.name}> не закрыт`, start);
      const key = name();
      spaces();
      if (text[i] !== '=') fail(`у атрибута ${key} нет значения`);
      i++;
      spaces();
      const q = text[i];
      if (q !== '"' && q !== "'") fail(`значение ${key} не в кавычках`);
      const end = text.indexOf(q!, i + 1);
      if (end < 0) fail(`значение ${key} не закрыто`);
      // Line breaks and tabs in an attribute are spaces, as XML normalises them.
      el.attrs[key] = decode(text.slice(i + 1, end), i).replace(/[\t\r\n]/g, ' ');
      i = end + 1;
    }
    for (;;) {
      const lt = text.indexOf('<', i);
      if (lt < 0) fail(`<${el.name}> не закрыт`, start);
      if (lt > i) el.children.push(decode(text.slice(i, lt), i));
      i = lt;
      if (text.startsWith('</', i)) {
        i += 2;
        const closing = name();
        if (closing !== el.name) fail(`</${closing}> закрывает <${el.name}>`);
        spaces();
        if (text[i] !== '>') fail(`</${closing}> не закрыт`);
        i++;
        return el;
      }
      if (text.startsWith('<!--', i)) skipPast('-->', 'комментарий');
      else if (text.startsWith('<![CDATA[', i)) {
        i += '<![CDATA['.length;
        const from = skipPast(']]>', 'CDATA');
        el.children.push(text.slice(from, i - 3));
      } else if (text.startsWith('<?', i)) skipPast('?>', 'инструкция');
      else el.children.push(element(el));
    }
  };

  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (misc());
  if (text[i] !== '<') fail('это не XML');
  const root = element(null);
  while (misc());
  if (i < text.length) fail('после корневого элемента ещё что-то есть');
  return root;
}

// The element's own name without its namespace prefix: 'svg:rect' → 'rect'.
export const localName = (el: XmlElement): string => el.name.slice(el.name.indexOf(':') + 1);

// The text inside an element and all its descendants.
export const textContent = (el: XmlElement): string => el.children.map((c) => (typeof c === 'string' ? c : textContent(c))).join('');
