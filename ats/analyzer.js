// Analizador ATS client-side: extracción con pdf.js + orquestación del widget.
// El PDF del usuario nunca sale del navegador.
import { evaluateAll, computeScore } from './rules.js';

const PDFJS_VERSION = '4.10.38';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;
const MAX_FILE_MB = 10;
const LINE_Y_TOLERANCE = 3;
// Gap horizontal (pt) que separa segmentos de una misma altura: el canalón de un
// CV a dos columnas es mucho mayor que un espacio entre palabras.
const SEGMENT_GAP_PT = 24;
const SCORE_OK_MIN = 80;
const SCORE_WARN_MIN = 50;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    // Si el CDN falla, se limpia el cache para que el siguiente intento reintente.
    pdfjsPromise = import(`${PDFJS_BASE}/pdf.min.mjs`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
      return pdfjs;
    }).catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

function pageHasImages(pdfjs, opList) {
  const { OPS } = pdfjs;
  const imageOps = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject];
  return opList.fnArray.some((fn) => imageOps.includes(fn));
}

function collectFontNames(page, fontIds, fontNames) {
  for (const fid of fontIds) {
    try {
      const font = page.commonObjs.get(fid);
      if (font && font.name) fontNames.add(font.name);
    } catch (_) { /* fuente no resuelta aún: el check de fuentes queda en manual */ }
  }
}

// Agrupa items por altura (y) y parte cada renglón en segmentos cuando hay un
// gap horizontal grande: así cada columna produce sus propias líneas con su x
// real, en vez de fundirse en una sola línea con el x de la columna izquierda.
function buildPageLines(items, pageNum) {
  const rows = new Map();
  const fontIds = new Set();
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const yKey = Math.round(item.transform[5] / LINE_Y_TOLERANCE);
    if (!rows.has(yKey)) rows.set(yKey, { y: item.transform[5], parts: [] });
    rows.get(yKey).parts.push({ x: item.transform[4], width: item.width || 0, str: item.str });
    if (item.fontName) fontIds.add(item.fontName);
  }
  const lines = [];
  for (const row of [...rows.values()].sort((a, b) => b.y - a.y)) {
    const parts = row.parts.sort((a, b) => a.x - b.x);
    let segment = null;
    for (const part of parts) {
      const prevEnd = segment ? segment.endX : -Infinity;
      if (!segment || part.x - prevEnd > SEGMENT_GAP_PT) {
        segment = { x: part.x, endX: part.x + part.width, strs: [part.str] };
        lines.push(segment);
      } else {
        segment.strs.push(part.str);
        segment.endX = Math.max(segment.endX, part.x + part.width);
      }
    }
  }
  return {
    fontIds,
    lines: lines.map((s) => ({
      text: s.strs.join(' ').replace(/\s+/g, ' ').trim(),
      x: s.x,
      page: pageNum,
    })),
  };
}

export async function extractFacts(file, jobText) {
  const pdfjs = await loadPdfjs();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const lines = [];
    const fontNames = new Set();
    let hasImages = false;
    let pageWidth = 0;

    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      pageWidth = Math.max(pageWidth, page.getViewport({ scale: 1 }).width);
      // getOperatorList también resuelve las fuentes en commonObjs, por eso se
      // pide en cada página aunque hasImages ya sea true.
      const [opList, content] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
      if (!hasImages) hasImages = pageHasImages(pdfjs, opList);
      const pageData = buildPageLines(content.items, p);
      collectFontNames(page, pageData.fontIds, fontNames);
      lines.push(...pageData.lines);
    }

    const fullText = lines.map((l) => l.text).join('\n');
    return {
      fileName: file.name,
      fullText,
      lines,
      fontNames: [...fontNames],
      hasImages,
      charCount: fullText.replace(/\s/g, '').length,
      pageWidth,
      jobText: (jobText || '').trim() || null,
    };
  } finally {
    doc.destroy();
  }
}

/* ---------- UI ---------- */

const ICONS = { pasa: '✅', falla: '❌', manual: '👁️' };

function track(event, params) {
  try {
    if (window.gtag) window.gtag('event', event, params || {});
    if (window.fbq) window.fbq('trackCustom', event, params || {});
  } catch (_) { /* analytics nunca rompe el análisis */ }
}

function panel() { return document.getElementById('ats-result'); }

function resetPanel() {
  const el = panel();
  el.hidden = false;
  el.textContent = '';
  return el;
}

function renderMessage(msg, className) {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = msg;
  resetPanel().appendChild(p);
}

function scoreClass(pct) {
  if (pct >= SCORE_OK_MIN) return 'ats-ok';
  if (pct >= SCORE_WARN_MIN) return 'ats-warn';
  return 'ats-bad';
}

function buildScoreHead(score, totalRules) {
  const head = document.createElement('div');
  head.className = 'ats-score';
  if (score.pct === null) {
    const p = document.createElement('p');
    p.className = 'ats-error';
    p.textContent = 'No pudimos verificar automáticamente ningún punto. Revisa la lista manualmente.';
    head.appendChild(p);
    return head;
  }
  const num = document.createElement('div');
  num.className = `ats-pct display ${scoreClass(score.pct)}`;
  num.textContent = `${score.pct}%`;
  const cap = document.createElement('p');
  cap.className = 'ats-caption';
  cap.textContent = `de cumplimiento ATS, basado en ${score.evaluables} de ${totalRules} puntos verificables`;
  head.append(num, cap);
  return head;
}

function buildResultsList(results) {
  const list = document.createElement('ul');
  list.className = 'ats-list';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = `ats-item ats-${r.estado}`;
    const title = document.createElement('strong');
    title.textContent = `${ICONS[r.estado]} ${r.id}. ${r.titulo}`;
    const detail = document.createElement('span');
    detail.textContent = r.estado === 'falla' ? `${r.detalle} Consejo: ${r.consejo}` : r.detalle;
    li.append(title, detail);
    list.appendChild(li);
  }
  return list;
}

function buildCtas() {
  const ctas = document.createElement('div');
  ctas.className = 'ats-ctas';
  // Apunta al bloque de descarga de arriba (no directo al PDF): cuando la
  // descarga quede detrás del form de MailerLite, este CTA queda cubierto solo.
  const pdf = document.createElement('a');
  pdf.href = '#descarga';
  pdf.className = 'cta-btn';
  pdf.textContent = '📄 Descarga el checklist para corregir estos puntos';
  const svc = document.createElement('a');
  svc.href = '/';
  svc.className = 'ats-cta-svc';
  svc.textContent = '¿Prefieres que lo hagamos por ti? Conoce JobButler →';
  ctas.append(pdf, svc);
  return ctas;
}

function renderResults(score, results) {
  const el = resetPanel();
  el.appendChild(buildScoreHead(score, results.length));
  el.appendChild(buildResultsList(results));
  el.appendChild(buildCtas());
}

async function analyze(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    renderMessage('Solo aceptamos archivos PDF.', 'ats-error');
    return;
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    renderMessage(`El archivo pesa más de ${MAX_FILE_MB} MB. Exporta una versión más ligera.`, 'ats-error');
    return;
  }
  renderMessage('Analizando tu CV… (no sale de tu navegador)', 'ats-status');
  track('ats_analyze_start');
  let pdfjsReady = false;
  try {
    await loadPdfjs();
    pdfjsReady = true;
    const jobText = document.getElementById('ats-job').value;
    const facts = await extractFacts(file, jobText);
    const results = evaluateAll(facts);
    const score = computeScore(results);
    renderResults(score, results);
    track('ats_analyze_complete', { score: score.pct, verificables: score.evaluables });
  } catch (err) {
    console.error('[ats] análisis falló:', err);
    renderMessage(
      pdfjsReady
        ? 'No pudimos leer tu PDF. Verifica que no esté protegido con contraseña e intenta re-exportarlo.'
        : 'No se pudo cargar el analizador (¿sin conexión o red restringida?). Revisa tu conexión e intenta de nuevo.',
      'ats-error',
    );
  }
}

function init() {
  const drop = document.getElementById('ats-drop');
  const input = document.getElementById('ats-input');
  const btn = document.getElementById('ats-btn');
  if (!drop || !input || !btn) return;

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files[0];
    // Reset para que re-seleccionar el mismo archivo vuelva a disparar 'change'
    // (flujo: analizar → pegar vacante → re-analizar el mismo PDF).
    input.value = '';
    analyze(file);
  });
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('ats-over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('ats-over');
  }));
  drop.addEventListener('drop', (e) => analyze(e.dataTransfer.files[0]));
  // Soltar el PDF fuera de la zona no debe navegar la pestaña al archivo.
  ['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
}

init();
