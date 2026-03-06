// js/renderer.js
// ─────────────────────────────────────────────────────────
// Rendert JSON-Blöcke von Claude in HTML-Komponenten.
// Neue Block-Typen: Render-Funktion hinzufügen + switch-case ergänzen.
// ─────────────────────────────────────────────────────────

'use strict';

/* ── Markdown-Konfiguration ── */
if (typeof marked !== 'undefined') {
  marked.use({ breaks: true, gfm: true });
}
function md(text) {
  return typeof marked !== 'undefined' ? marked.parse(text || '') : (text || '');
}

/* ── Haupt-Renderer ──────────────────────────────────────── */
function renderBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks.map(renderBlock).join('');
}

function renderBlock(block) {
  try {
    switch (block.type) {
      case 'text': return renderText(block);
      case 'card': return renderCard(block);
      case 'image_gallery': return renderImageGallery(block);
      case 'table': return renderTable(block);
      case 'multi_select': return renderMultiSelect(block);
      case 'toggle': return renderToggle(block);
      case 'button_group': return renderButtonGroup(block);
      case 'info_box': return renderInfoBox(block);
      default:
        return `<div class="block-text"><p><em>[Unbekannter Block-Typ: ${escHtml(block.type)}]</em></p></div>`;
    }
  } catch (e) {
    console.error('renderBlock error:', e, block);
    return '';
  }
}

/* ── Einzelne Block-Renderer ─────────────────────────────── */

function renderText({ content }) {
  return `<div class="block block-text">${md(content)}</div>`;
}

function renderCard({ title, description, image, link }) {
  return `
    <div class="block block-card">
      ${image ? `<div class="card-img-wrap"><img src="${escHtml(image)}" alt="${escHtml(title)}" loading="lazy"></div>` : ''}
      <div class="card-body">
        <h3 class="card-title">${escHtml(title)}</h3>
        <p class="card-desc">${escHtml(description)}</p>
        ${link ? `<a class="card-link" href="${escHtml(link)}" target="_blank" rel="noopener">Mehr erfahren →</a>` : ''}
      </div>
    </div>`;
}

function renderImageGallery({ images }) {
  if (!images?.length) return '';
  const items = images.map(img =>
    `<div class="gallery-item">
       <img src="${escHtml(img.src)}" alt="${escHtml(img.alt)}" loading="lazy">
       ${img.alt ? `<p class="gallery-caption">${escHtml(img.alt)}</p>` : ''}
     </div>`
  ).join('');
  return `<div class="block block-gallery">${items}</div>`;
}

function renderTable({ headers, rows }) {
  const head = headers?.map(h => `<th>${escHtml(h)}</th>`).join('') ?? '';
  const body = rows?.map(row =>
    `<tr>${row.map(cell => `<td>${escHtml(String(cell))}</td>`).join('')}</tr>`
  ).join('') ?? '';
  return `
    <div class="block block-table-wrap">
      <table class="block-table">
        ${head ? `<thead><tr>${head}</tr></thead>` : ''}
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderMultiSelect({ label, options }) {
  const opts = options?.map(o =>
    `<label class="select-option">
       <input type="checkbox" value="${escHtml(o.id)}" class="select-cb">
       <span class="cb-custom"></span>
       <span class="cb-label">${escHtml(o.text)}</span>
     </label>`
  ).join('') ?? '';
  return `
    <div class="block block-multi-select">
      ${label ? `<p class="select-label">${escHtml(label)}</p>` : ''}
      <div class="select-options">${opts}</div>
      <button class="btn-confirm" onclick="submitSelection(this)">Auswahl bestätigen</button>
    </div>`;
}

function renderToggle({ label, content }) {
  return `
    <details class="block block-toggle">
      <summary class="toggle-summary">
        <span>${escHtml(label)}</span>
        <svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </summary>
      <div class="toggle-content">${md(content)}</div>
    </details>`;
}

function renderButtonGroup({ buttons }) {
  const btns = buttons?.map(b =>
    `<button
       class="action-btn"
       data-action="${escHtml(b.action)}"
       data-value="${escHtml(b.value)}"
       onclick="handleAction('${escHtml(b.action)}','${escHtml(b.value)}')">
       ${escHtml(b.label)}
     </button>`
  ).join('') ?? '';
  return `<div class="block block-buttons">${btns}</div>`;
}

function renderInfoBox({ variant, title, content }) {
  const icons = { info: 'ℹ️', warning: '⚠️', success: '✅' };
  const icon = icons[variant] ?? 'ℹ️';
  return `
    <div class="block block-info-box ${escHtml(variant || 'info')}">
      <div class="info-header">
        <span class="info-icon">${icon}</span>
        ${title ? `<strong class="info-title">${escHtml(title)}</strong>` : ''}
      </div>
      <p class="info-content">${escHtml(content)}</p>
    </div>`;
}

/* ── Interaktions-Handler ───────────────────────────────── */

/**
 * Wird von Button-Group-Buttons aufgerufen.
 * Schickt die Aktion als neue User-Nachricht.
 */
function handleAction(action, value) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  input.value = value;
  document.getElementById('chat-form')?.dispatchEvent(new Event('submit', { bubbles: true }));
}

/**
 * Wird vom Multi-Select "Bestätigen"-Button aufgerufen.
 */
function submitSelection(btn) {
  const container = btn.closest('.block-multi-select');
  if (!container) return;
  const selected = [...container.querySelectorAll('.select-cb:checked')]
    .map(cb => cb.value);
  if (selected.length === 0) return;

  const input = document.getElementById('chat-input');
  if (!input) return;
  input.value = `Meine Auswahl: ${selected.join(', ')}`;
  document.getElementById('chat-form')?.dispatchEvent(new Event('submit', { bubbles: true }));
}

/* ── Hilfsfunktionen ─────────────────────────────────────── */

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// parseResponse() wurde entfernt - das JSON-Parsing passiert bereits im Worker (index.js:186)
