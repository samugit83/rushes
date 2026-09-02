// Injected into every page before it loads. A headless screencast records page
// content, not the desktop, so the real OS cursor is never captured — we draw
// our own: a cursor dot that follows real mousemove events, a ripple on click,
// and a focus ring the driver can toggle around an element. Everything lives in
// a shadow-hosted overlay so it never collides with the app's own styles or
// shows up in the app's DOM queries.

const DEFAULT_ACCENT = '#f59e0b';

export function overlayInit(accent = DEFAULT_ACCENT): string {
  const a = /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : DEFAULT_ACCENT;
  return `(() => {
  if (window.__demoOverlayReady) return;
  window.__demoOverlayReady = true;
  const ACCENT = ${JSON.stringify(a)};

  const mount = () => {
    if (!document.body || document.getElementById('__demo_overlay_host__')) return;
    const host = document.createElement('div');
    host.id = '__demo_overlay_host__';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = \`
      <style>
        .cursor{position:fixed;left:0;top:0;width:22px;height:22px;margin:-4px 0 0 -4px;
          transform:translate(-9999px,-9999px);transition:transform .05s linear;z-index:3;}
        .cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.55));}
        .ripple{position:fixed;width:14px;height:14px;border-radius:50%;
          border:3px solid \${ACCENT};margin:-7px 0 0 -7px;opacity:.9;z-index:2;
          animation:rip .55s ease-out forwards;}
        @keyframes rip{to{transform:scale(4.2);opacity:0;}}
        .ring{position:fixed;border:3px solid \${ACCENT};border-radius:12px;
          box-shadow:0 0 0 3px rgba(0,0,0,.25),0 0 26px rgba(0,0,0,.35);
          transition:all .18s ease;opacity:0;z-index:1;}
      </style>
      <div class="cursor" id="c">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M2 2 L2 17 L6.2 13 L9 19 L12 17.6 L9.2 11.8 L15 11.5 Z"
                fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="ring" id="r"></div>\`;
    document.documentElement.appendChild(host);

    const cursor = root.getElementById('c');
    const ring = root.getElementById('r');

    window.__demoMove = (x, y) => { cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    document.addEventListener('mousemove', (e) => window.__demoMove(e.clientX, e.clientY), true);

    window.__demoRipple = (x, y) => {
      const d = document.createElement('div');
      d.className = 'ripple';
      d.style.left = x + 'px'; d.style.top = y + 'px';
      root.appendChild(d);
      setTimeout(() => d.remove(), 600);
    };
    document.addEventListener('mousedown', (e) => window.__demoRipple(e.clientX, e.clientY), true);

    window.__demoRing = (rect) => {
      if (!rect) { ring.style.opacity = '0'; return; }
      ring.style.left = (rect.x - 6) + 'px';
      ring.style.top = (rect.y - 6) + 'px';
      ring.style.width = (rect.width + 12) + 'px';
      ring.style.height = (rect.height + 12) + 'px';
      ring.style.opacity = '1';
    };
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
  // Re-mount after client-side navigations that replace <body>.
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: false });
})();`;
}

/**
 * Live in-page redaction (E5). Blurring selectors in the page beats editing the
 * app or its data: it costs nothing, it is visible in the recording, and it
 * cannot be forgotten in one environment and remembered in another.
 */
export function redactionInit(selectors: string[]): string {
  return `(() => {
  const SEL = ${JSON.stringify(selectors)};
  if (!SEL.length) return;
  const apply = () => {
    if (!document.head) return;
    if (document.getElementById('__rushes_redact__')) return;
    const s = document.createElement('style');
    s.id = '__rushes_redact__';
    s.textContent = SEL.join(',') + '{filter:blur(9px) !important;}';
    document.head.appendChild(s);
  };
  if (document.head) apply();
  else document.addEventListener('DOMContentLoaded', apply);
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: false });
})();`;
}
