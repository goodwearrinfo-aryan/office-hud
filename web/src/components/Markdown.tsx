import React from 'react';

// Minimal markdown: headings, lists, bold/italic/code -- enough for hive .md files.
function inline(text: string, keyBase: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(_[^_]+_)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > i) parts.push(text.slice(i, m.index));
    if (m[1]) parts.push(<code key={`${keyBase}-${k++}`}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={`${keyBase}-${k++}`}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={`${keyBase}-${k++}`}>{m[3].slice(1, -1)}</em>);
    i = m.index + m[0].length;
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

export default function Markdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const blocks: React.ReactNode[] = [];
  let li: string[] = [];
  const flushList = (k: number) => {
    if (li.length) {
      blocks.push(
        <ul key={`ul-${k}`}>
          {li.map((item, j) => (
            <li key={j}>{inline(item, `li-${k}-${j}`)}</li>
          ))}
        </ul>,
      );
      li = [];
    }
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (line.startsWith('### ')) { flushList(idx); blocks.push(<h3 key={idx}>{inline(line.slice(4), `h3-${idx}`)}</h3>); }
    else if (line.startsWith('## ')) { flushList(idx); blocks.push(<h2 key={idx}>{inline(line.slice(3), `h2-${idx}`)}</h2>); }
    else if (line.startsWith('# ')) { flushList(idx); blocks.push(<h1 key={idx}>{inline(line.slice(2), `h1-${idx}`)}</h1>); }
    else if (line.startsWith('- ') || line.startsWith('* ')) { li.push(line.slice(2)); }
    else if (line.trim() === '') { flushList(idx); }
    else { flushList(idx); blocks.push(<p key={idx}>{inline(line, `p-${idx}`)}</p>); }
  });
  flushList(99999);
  return <div className="md">{blocks}</div>;
}
