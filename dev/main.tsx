import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import manifest from '../manifest.json';
import ImmichSlideshow from '../src/index';
import type { Fetcher } from '../src/immich';
import { makeHostDisplayCache } from './host-cache';

// Stand-in for the host: just enough SDK for the module to run.
(window as unknown as { React: typeof React }).React = React;
(window as unknown as { __HS_SDK__: unknown }).__HS_SDK__ = {
  displayCache: makeHostDisplayCache(),
  emit: (e: unknown) => console.info('[host emit]', e),
};

// The real module goes through the host proxy; here the fake Immich is on
// this same dev server, so a plain fetch does.
const devFetcher: Fetcher = async (req) => {
  const res = await fetch(req.url);
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep the text */ }
  return { status: res.status, body };
};

const params = new URLSearchParams(location.search);
const style = {
  fontSize: Number(params.get('fs') ?? manifest.defaultStyle.fontSize), fontFamily: 'inter', textColor: '#ffffff',
  backgroundColor: manifest.defaultStyle.backgroundColor, borderRadius: manifest.defaultStyle.borderRadius,
  padding: manifest.defaultStyle.padding, opacity: 1, backdropBlur: 0,
};
const config: Record<string, unknown> = {
  ...manifest.defaultConfig,
  shareLink: `${location.origin}/share/demo-key`,
  intervalSeconds: 4,
  refreshMinutes: 1,
  ...Object.fromEntries([...params].filter(([k]) => !['w', 'h', 'fs'].includes(k))),
};

/** The module at a size you can change, to check photos refit live. */
function Harness() {
  const [w, setW] = useState(Number(params.get('w') ?? manifest.defaultSize.w));
  const [h, setH] = useState(Number(params.get('h') ?? manifest.defaultSize.h));
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    (window as unknown as { setBox: unknown }).setBox = (nw: number, nh: number) => { setW(nw); setH(nh); };
  }, []);
  const add = async () => setCount((await (await fetch('/dev/add', { method: 'POST' })).json()).count);
  const btn = { font: 'inherit', padding: '4px 10px', borderRadius: 6, border: '1px solid #fff4', background: '#0006', color: '#fff', cursor: 'pointer' };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, color: '#fff', fontSize: 13, alignItems: 'center', flexWrap: 'wrap' }}>
        {[[960, 540], [540, 960], [600, 600], [1200, 360], [320, 200]].map(([bw, bh]) => (
          <button key={`${bw}x${bh}`} style={btn} onClick={() => { setW(bw); setH(bh); }}>{bw}×{bh}</button>
        ))}
        <button style={btn} onClick={add}>Simulate phone upload</button>
        <span>{w}×{h}{count !== null ? ` · album has ${count}` : ''}</span>
      </div>
      <div id="module" style={{ width: w, height: h, resize: 'both', overflow: 'hidden' }}>
        <ImmichSlideshow config={config} style={style} fetcher={devFetcher} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
