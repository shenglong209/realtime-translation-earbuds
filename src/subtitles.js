// Bilingual subtitles — Shadow DOM overlay.
//
// The naive approach (injecting divs into the meeting's caption container)
// dies: React re-renders wipe them. Instead the overlay lives OUTSIDE the
// app's React root: a host element appended to document.body with a Shadow
// DOM attached. React only reconciles inside its own tree, so its
// re-renders never see, wipe, or fight these nodes. The shadow boundary
// also isolates CSS both ways.
//
// Runs as a normal (ISOLATED world) content script; it never touches the
// app's DOM nodes, it only appends one host to <body>.
export class SubtitleOverlay {
  constructor({ bottomPx = 48 } = {}) {
    this.host = document.createElement('div');
    this.host.id = 'rt-subtitle-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        position: fixed;
        left: 50%;
        bottom: ${bottomPx}px;
        transform: translateX(-50%);
        z-index: 2147483647;
        pointer-events: none;
        text-align: center;
        font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
        max-width: 80vw;
      }
      .orig {
        font-size: 15px;
        color: rgba(255, 255, 255, 0.65);
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
        margin-bottom: 2px;
      }
      .trans {
        font-size: 22px;
        font-weight: 600;
        color: #fff;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95);
      }
    `;
    this.origEl = document.createElement('div');
    this.origEl.className = 'orig';
    this.transEl = document.createElement('div');
    this.transEl.className = 'trans';
    this.shadow.append(style, this.origEl, this.transEl);

    document.body.appendChild(this.host);

    // Re-mount if the app ever blows the host away (SPA route change).
    this.observer = new MutationObserver(() => {
      if (!document.body.contains(this.host)) {
        document.body.appendChild(this.host);
      }
    });
    this.observer.observe(document.body, { childList: true });
  }

  // Only our own text nodes are ever updated, on transcript events
  // (a few times a second, never per frame).
  update(original, translation) {
    if (original != null) this.origEl.textContent = original;
    if (translation != null) this.transEl.textContent = translation;
  }

  hide() {
    this.host.style.display = 'none';
  }

  show() {
    this.host.style.display = '';
  }

  destroy() {
    this.observer.disconnect();
    this.host.remove();
  }
}

// Auto-mount when loaded as a content script; the service worker drives it
// via chrome.runtime messages: { type: 'subtitle', original, translation }.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  const overlay = new SubtitleOverlay();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'subtitle') overlay.update(msg.original, msg.translation);
    if (msg.type === 'subtitle-hide') overlay.hide();
    if (msg.type === 'subtitle-show') overlay.show();
    // Relay translation PCM to the MAIN-world virtual mic (this isolated
    // world cannot touch the page's navigator; the MAIN-world script can).
    if (msg.type === 'translation-audio') {
      window.postMessage({ type: 'translation-audio', pcm: msg.pcm }, '*');
    }
  });
}
