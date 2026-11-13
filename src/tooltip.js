'use strict';
// Module tooltip.js: the panel's hover texts. Every element with data-tip="…" shows its text in one themed .tip
// element (the browser's native title tooltip ignores the theme and the panel's type). Event delegation on the
// document, so rows rendered later need nothing but the attribute; an empty data-tip shows nothing.
// Loaded early: it needs nothing from other modules; hideTip is there for code that moves things under the pointer.
/* exported hideTip */

const TIP_DELAY = 350; // ms of hovering before the tip shows (focus from the keyboard shows it at once)
const TIP_GAP = 6; // px between the element and its tip
const TIP_PAD = 4; // px the tip keeps from the panel's edges
let tipNode = null; // the one .tip element, made on first use and reused
let tipFor = null; // the element the tip is shown (or about to be shown) for
let tipTimer = 0;
let tipPointer = false; // the last input was the mouse: a focus it causes shows no tip

const tipTarget = (node) => (node && node.closest ? node.closest('[data-tip]') : null);

function tipElement() {
  if (!tipNode || !tipNode.isConnected) {
    tipNode = document.createElement('div');
    tipNode.className = 'tip';
    tipNode.setAttribute('role', 'tooltip');
    document.body.appendChild(tipNode);
  }
  return tipNode;
}

// Below the element, left-aligned with it; above it when there is no room below; inside the panel horizontally.
function placeTip(target, tip) {
  const r = target.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let top = r.bottom + TIP_GAP;
  const above = top + h > vh - TIP_PAD && r.top - TIP_GAP - h >= TIP_PAD;
  if (above) top = r.top - TIP_GAP - h;
  const left = Math.max(TIP_PAD, Math.min(r.left, vw - w - TIP_PAD));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
  tip.classList.toggle('above', above);
}

function showTip(target) {
  clearTimeout(tipTimer);
  tipTimer = 0;
  const text = target.dataset.tip;
  if (!text || !target.isConnected) { hideTip(); return; }
  tipFor = target;
  const tip = tipElement();
  tip.textContent = text;
  placeTip(target, tip);
  tip.classList.add('show');
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = 0;
  tipFor = null;
  if (tipNode) tipNode.classList.remove('show');
}

function onTipOver(e) {
  const t = tipTarget(e.target);
  if (t === tipFor) return;
  hideTip();
  if (!t || !t.dataset.tip) return;
  tipFor = t;
  tipTimer = setTimeout(() => { if (tipFor === t) showTip(t); }, TIP_DELAY);
}

document.addEventListener('mouseover', onTipOver);
document.addEventListener('mouseout', (e) => { if (tipFor && !(e.relatedTarget && tipFor.contains(e.relatedTarget))) hideTip(); });
document.addEventListener('mousedown', () => { tipPointer = true; hideTip(); }, true);
document.addEventListener('click', hideTip, true);
document.addEventListener('keydown', (e) => { tipPointer = false; if (e.key === 'Escape') hideTip(); }, true);
document.addEventListener('focusin', (e) => {
  const t = tipTarget(e.target);
  if (t && !tipPointer && t.dataset.tip) showTip(t);
});
document.addEventListener('focusout', (e) => { if (tipFor && tipFor.contains(e.target)) hideTip(); });
document.addEventListener('scroll', hideTip, true); // capture: the chat and the menus scroll, not the document
window.addEventListener('resize', hideTip);
window.addEventListener('blur', hideTip);
