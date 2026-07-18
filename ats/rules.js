// Reglas puras del analizador ATS de /checklist.
// Entrada: objeto `facts` (ver extractFacts en analyzer.js). Sin DOM, sin pdf.js.

const GENERAL_STOPWORDS = new Set([
  // español
  'de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por', 'un', 'para', 'con', 'no',
  'una', 'su', 'al', 'es', 'lo', 'como', 'mas', 'pero', 'sus', 'le', 'ya', 'o', 'fue', 'este', 'ha', 'si',
  'porque', 'esta', 'son', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'ser', 'tiene', 'tambien', 'me',
  'hasta', 'hay', 'donde', 'han', 'quien', 'estan', 'estado', 'desde', 'todo', 'nos', 'durante', 'todos',
  'uno', 'les', 'ni', 'contra', 'otros', 'ese', 'eso', 'ante', 'ellos', 'esto', 'antes', 'algunos',
  'unos', 'otro', 'otras', 'otra', 'tanto', 'esa', 'estos', 'mucho', 'nada', 'muchos', 'cual', 'sea',
  'poco', 'estar', 'haber', 'estas', 'estaba', 'algo', 'tener', 'buscas', 'tus',
  // inglés
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'will', 'are', 'you', 'your', 'our', 'have',
  'has', 'can', 'not', 'all', 'who', 'what', 'when', 'their', 'they', 'more', 'most', 'about', 'able',
]);

// Boilerplate de anuncios que no discrimina candidatos. Solo se filtra al extraer
// keywords de la vacante — no al comparar títulos (en un puesto de "Compensaciones
// y Beneficios" estas palabras SÍ son señal).
const JOB_JARGON = new Set([
  'experiencia', 'anos', 'buscamos', 'ofrecemos', 'requisitos', 'empresa', 'puesto', 'vacante',
  'trabajo', 'equipo', 'conocimientos', 'manejo', 'nivel', 'sueldo', 'salario', 'beneficios',
  'prestaciones', 'horario', 'modalidad', 'ubicacion', 'funciones', 'actividades', 'zona',
  'responsabilidades', 'deseable', 'indispensable', 'indispensables', 'importante', 'solicita',
  'integrarse',
  'experience', 'years', 'team', 'work', 'role', 'position', 'company', 'skills', 'required',
  'requirements', 'responsibilities', 'benefits', 'salary', 'join', 'looking',
]);

export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const TOKEN_RE = /[a-z0-9+#.]{3,}/g;

function tokenize(text) {
  return (normalize(text).match(TOKEN_RE) || [])
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length >= 3);
}

const KEYWORD_MAX = 15;

export function extractKeywords(jobText) {
  const freq = new Map();
  for (const t of tokenize(jobText)) {
    if (GENERAL_STOPWORDS.has(t) || JOB_JARGON.has(t) || /^\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, KEYWORD_MAX)
    .map(([t]) => t);
}

/* ---------- Reglas ---------- */

const MIN_LINES_FOR_COLUMNS = 10;
const COLUMN_BAND_MIN_FRAC = 0.25;   // fracción de líneas que debe tener cada banda
const COLUMN_LEFT_MAX_X = 0.25;      // banda izquierda: inicia antes del 25% del ancho
const COLUMN_RIGHT_MIN_X = 0.32;     // banda derecha: una 2a columna real inicia entre
const COLUMN_RIGHT_MAX_X = 0.68;     // 32% y 68%; más allá suelen ser fechas alineadas

export function ruleSingleColumn(facts) {
  const lines = (facts.lines || []).filter((l) => (l.text || '').trim().length >= 3);
  if (lines.length < MIN_LINES_FOR_COLUMNS || !facts.pageWidth) {
    return { estado: 'manual', detalle: 'No hay suficiente texto para detectar columnas.' };
  }
  const w = facts.pageWidth;
  const left = lines.filter((l) => l.x < w * COLUMN_LEFT_MAX_X).length / lines.length;
  const right = lines.filter(
    (l) => l.x > w * COLUMN_RIGHT_MIN_X && l.x < w * COLUMN_RIGHT_MAX_X,
  ).length / lines.length;
  if (left > COLUMN_BAND_MIN_FRAC && right > COLUMN_BAND_MIN_FRAC) {
    return { estado: 'falla', detalle: 'Detectamos dos bandas de texto paralelas: parece un CV a dos o más columnas.' };
  }
  return { estado: 'pasa', detalle: 'El texto fluye en una sola columna.' };
}

const SECTION_MIN_FOUND = 2;
const SECTION_PATTERNS = [
  /\b(experiencia|work experience|professional experience|employment history)\b/,
  /\b(educacion|formacion|education|estudios)\b/,
  /\b(habilidades|competencias|skills|aptitudes)\b/,
];

export function ruleSections(facts) {
  const text = normalize(facts.fullText);
  const found = SECTION_PATTERNS.filter((re) => re.test(text)).length;
  if (found >= SECTION_MIN_FOUND) return { estado: 'pasa', detalle: `Encontramos ${found} de 3 encabezados estándar.` };
  return { estado: 'falla', detalle: 'No encontramos encabezados estándar como "Experiencia", "Educación" o "Habilidades".' };
}

const KEYWORD_PASS_COVERAGE = 0.6;
const KEYWORD_FAIL_COVERAGE = 0.4;
const KEYWORD_LIST_MAX = 8;

export function ruleKeywords(facts) {
  if (!facts.jobText || !facts.jobText.trim()) {
    return { estado: 'manual', detalle: 'Pega la descripción de la vacante para medir el match de keywords.' };
  }
  const keywords = extractKeywords(facts.jobText);
  if (keywords.length === 0) return { estado: 'manual', detalle: 'La vacante pegada no tiene términos analizables.' };
  // Match por token completo, no substring: "ios" no debe acreditarse por "servicios".
  const cvTokens = new Set(tokenize(facts.fullText));
  const faltan = keywords.filter((k) => !cvTokens.has(k));
  const cobertura = (keywords.length - faltan.length) / keywords.length;
  const resumen = `${Math.round(cobertura * 100)}% de ${keywords.length} keywords de la vacante`;
  if (cobertura >= KEYWORD_PASS_COVERAGE) return { estado: 'pasa', detalle: `Tu CV cubre ${resumen}.` };
  if (cobertura < KEYWORD_FAIL_COVERAGE) {
    return { estado: 'falla', detalle: `Tu CV solo cubre ${resumen}. Faltan: ${faltan.slice(0, KEYWORD_LIST_MAX).join(', ')}.` };
  }
  return { estado: 'manual', detalle: `Cobertura media (${resumen}). Considera sumar: ${faltan.slice(0, KEYWORD_LIST_MAX).join(', ')}.` };
}

export function ruleNoImages(facts) {
  if (facts.hasImages) return { estado: 'falla', detalle: 'El PDF contiene imágenes, íconos, logos o gráficas: el ATS no los lee.' };
  return { estado: 'pasa', detalle: 'Sin imágenes ni gráficas.' };
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_CANDIDATE_RE = /\+?\d[\d ().-]{6,}\d/g;
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 13;
const YEAR_RANGE_DIGITS_RE = /^(19|20)\d{2}(19|20)\d{2}$/;

function hasPhoneNumber(text) {
  const candidates = text.match(PHONE_CANDIDATE_RE) || [];
  return candidates.some((c) => {
    const digits = c.replace(/\D/g, '');
    if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return false;
    // "2019 - 2024" tiene 8 dígitos pero es un rango de años, no un teléfono.
    return !YEAR_RANGE_DIGITS_RE.test(digits);
  });
}

export function ruleContact(facts) {
  const hasEmail = EMAIL_RE.test(facts.fullText);
  const hasPhone = hasPhoneNumber(facts.fullText);
  if (hasEmail && hasPhone) return { estado: 'pasa', detalle: 'Email y teléfono legibles en el cuerpo del CV.' };
  const faltan = [!hasEmail && 'email', !hasPhone && 'teléfono'].filter(Boolean).join(' y ');
  return { estado: 'falla', detalle: `No encontramos ${faltan} como texto legible. Si está en el encabezado/pie de página o en una imagen, el ATS no lo ve.` };
}

const MIN_TEXT_CHARS = 100;

export function ruleSelectableText(facts) {
  if ((facts.charCount || 0) < MIN_TEXT_CHARS) {
    return { estado: 'falla', detalle: 'Tu PDF casi no tiene texto seleccionable: parece una imagen escaneada.' };
  }
  return { estado: 'pasa', detalle: 'El PDF tiene texto seleccionable.' };
}

const SAFE_FONTS = ['arial', 'helvetica', 'calibri', 'carlito', 'times', 'georgia', 'garamond',
  'cambria', 'verdana', 'tahoma', 'lato', 'roboto', 'liberation', 'dejavu', 'opensans', 'open sans', 'noto'];
const RISKY_FONTS = ['comic', 'script', 'brush', 'handw', 'chalk', 'marker', 'papyrus', 'impact'];
const FONT_LIST_MAX = 4;

export function ruleFonts(facts) {
  const names = (facts.fontNames || [])
    .map((n) => normalize(String(n).replace(/^[A-Z]{6}\+/, '')))
    .filter(Boolean);
  if (names.length === 0) return { estado: 'manual', detalle: 'No pudimos leer las fuentes del PDF.' };
  const risky = names.filter((n) => RISKY_FONTS.some((r) => n.includes(r)));
  if (risky.length) return { estado: 'falla', detalle: `Detectamos tipografías decorativas: ${risky.join(', ')}. Usa Arial, Calibri o Times.` };
  const unknown = names.filter((n) => !SAFE_FONTS.some((s) => n.includes(s)));
  if (unknown.length === 0) return { estado: 'pasa', detalle: 'Tipografías estándar en todo el documento.' };
  return { estado: 'manual', detalle: `Tipografías no reconocidas: ${unknown.slice(0, FONT_LIST_MAX).join(', ')}. Verifica que sean estándar.` };
}

// Mes completo y abreviado cuentan como UN solo estilo textual: distinguirlos
// generaba fallas en falso (p.ej. "May 2020" + "June 2021" en CVs en inglés).
const DATE_STYLES = [
  { name: 'mm/aaaa', re: /\b(0?[1-9]|1[0-2])[/.](19|20)\d{2}\b/g },
  { name: 'mes y año', re: /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december|ene|feb|mar|abr|jun|jul|ago|sept?|oct|nov|dic|jan|apr|aug|dec)\.?\s+(de\s+)?(19|20)\d{2}\b/g },
  { name: 'aaaa-aaaa', re: /\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2}|presente|actual|present)\b/g },
];
const MIN_DATES_FOR_CONSISTENCY = 2;

export function ruleDates(facts) {
  const text = normalize(facts.fullText);
  const estilos = [];
  let total = 0;
  for (const s of DATE_STYLES) {
    const m = text.match(s.re) || [];
    if (m.length > 0) estilos.push(s.name);
    total += m.length;
  }
  if (total < MIN_DATES_FOR_CONSISTENCY) return { estado: 'manual', detalle: 'Encontramos muy pocas fechas para evaluar la consistencia.' };
  if (estilos.length >= 2) return { estado: 'falla', detalle: `Mezclas formatos de fecha (${estilos.join(' y ')}). Usa uno solo, ej. mm/aaaa.` };
  return { estado: 'pasa', detalle: `Formato de fechas consistente (${estilos[0]}).` };
}

// "v\d" exige separador antes: sin él, "Nov2025" o "Av2" marcarían falla en falso.
const BAD_NAME_RE = /(final|copia|copy|borrador|draft|nuevo|actualizado|updated|\(\d+\)|(^|[ _\-.(])v\d)/i;
const CV_TOKEN_RE = /^(cv|resume|curriculum|vitae)$/;

export function ruleFileName(facts) {
  const name = String(facts.fileName || '');
  if (BAD_NAME_RE.test(name)) {
    return { estado: 'falla', detalle: `"${name}" incluye marcas como "final", "v2" o "(1)". Renómbralo a "Nombre-Apellido-CV.pdf".` };
  }
  const tokens = normalize(name.replace(/\.pdf$/i, '')).split(/[ _\-.]+/).filter(Boolean);
  const hasCvToken = tokens.some((t) => CV_TOKEN_RE.test(t));
  const nameTokens = tokens.filter((t) => !CV_TOKEN_RE.test(t) && /^[a-z]{2,}$/.test(t));
  if (hasCvToken && nameTokens.length >= 1) return { estado: 'pasa', detalle: 'Nombre de archivo claro.' };
  return { estado: 'falla', detalle: `"${name}" no sigue el patrón "Nombre-Apellido-CV.pdf".` };
}

const BULLET_RE = /^[•·▪‣◦*‐-―-]\s*/;
const ACTION_VERBS = new Set([
  // español (1a persona pretérito, normalizado sin acentos)
  'lidere', 'reduje', 'aumente', 'disene', 'implemente', 'desarrolle', 'cree', 'gestione', 'coordine',
  'optimice', 'logre', 'mejore', 'dirigi', 'negocie', 'lance', 'construi', 'automatice', 'analice',
  'capacite', 'supervise', 'administre', 'ejecute', 'planifique', 'estableci', 'genere', 'incremente',
  'disminui', 'organice', 'funde', 'impulse', 'integre', 'documente', 'migre', 'defini', 'presente',
  'entregue', 'recorte', 'ahorre', 'duplique', 'triplique', 'consegui', 'obtuve', 'alcance', 'opere',
  'monte', 'instale', 'configure', 'programe', 'redacte', 'publique', 'vendi', 'abri', 'cerre', 'forme',
  // inglés (pasado)
  'led', 'managed', 'built', 'created', 'designed', 'developed', 'improved', 'increased', 'reduced',
  'launched', 'delivered', 'implemented', 'coordinated', 'achieved', 'drove', 'spearheaded', 'founded',
  'automated', 'analyzed', 'trained', 'supervised', 'negotiated', 'optimized', 'streamlined', 'owned',
]);
const MIN_BULLETS = 3;
const VERB_PASS_RATIO = 0.5;
const VERB_FAIL_RATIO = 0.2;

export function ruleActionVerbs(facts) {
  const bullets = (facts.lines || [])
    .map((l) => (l.text || '').trim())
    .filter((t) => BULLET_RE.test(t))
    .map((t) => t.replace(BULLET_RE, ''));
  if (bullets.length < MIN_BULLETS) {
    return { estado: 'manual', detalle: 'No detectamos suficientes viñetas para evaluar los verbos de acción.' };
  }
  // Solo lista explícita: un fallback por terminación (é/í) marcaría
  // sustantivos como "Responsable" o "Apoyo" como verbos.
  const isAction = (t) => ACTION_VERBS.has(normalize(t).split(/\s+/)[0] || '');
  const ratio = bullets.filter(isAction).length / bullets.length;
  if (ratio >= VERB_PASS_RATIO) return { estado: 'pasa', detalle: `${Math.round(ratio * 100)}% de tus viñetas inician con verbo de acción.` };
  if (ratio < VERB_FAIL_RATIO) return { estado: 'falla', detalle: 'Tus viñetas casi no inician con verbos de acción ("Lideré", "Reduje", "Diseñé").' };
  return { estado: 'manual', detalle: `Solo ${Math.round(ratio * 100)}% de tus viñetas inician con verbo de acción. Súbelo a la mayoría.` };
}

const BARS_RE = /(?:[★☆●○▮▯◆■□▪♦]\s?){3,}/u;

export function ruleNoBars(facts) {
  if (BARS_RE.test(facts.fullText)) {
    return { estado: 'falla', detalle: 'Detectamos estrellas o barras para el nivel de habilidades. Descríbelo con texto ("Excel avanzado").' };
  }
  return { estado: 'pasa', detalle: 'Sin barras ni estrellas de nivel.' };
}

const TITLE_MIN_SHARED = 2;
const TITLE_SHARED_FRAC = 0.5;
const TITLE_TOP_LINES = 6;
const TITLE_TOKEN_RE = /[a-z]{4,}/g;

export function ruleTitle(facts) {
  if (!facts.jobText || !facts.jobText.trim()) {
    return { estado: 'manual', detalle: 'Verifica que el título bajo tu nombre coincida con el de la vacante (pégala para evaluarlo automático).' };
  }
  const topText = (facts.lines || []).filter((l) => l.page === 1).slice(0, TITLE_TOP_LINES).map((l) => l.text).join(' ');
  const jobFirstLine = facts.jobText.trim().split(/\n/)[0];
  const jobTokens = [...new Set(
    (normalize(jobFirstLine).match(TITLE_TOKEN_RE) || []).filter((t) => !GENERAL_STOPWORDS.has(t)),
  )];
  const cvTokens = new Set(normalize(topText).match(TITLE_TOKEN_RE) || []);
  const shared = jobTokens.filter((t) => cvTokens.has(t));
  if (shared.length >= TITLE_MIN_SHARED || (jobTokens.length > 0 && shared.length / jobTokens.length >= TITLE_SHARED_FRAC)) {
    return { estado: 'pasa', detalle: `El inicio de tu CV comparte términos con el título de la vacante (${shared.slice(0, 4).join(', ')}).` };
  }
  return { estado: 'manual', detalle: 'El inicio de tu CV no menciona el título de la vacante. Alinea tu título al del puesto.' };
}

/* ---------- Orquestación ---------- */

// needsText: la regla lee texto extraído; en un PDF escaneado (sin texto) queda
// en "manual" en vez de fallar en falso. Declarado por regla para que una regla
// nueva no pueda olvidar registrarse en una lista aparte.
const CHECKLIST = [
  { id: 1, titulo: 'Una sola columna', consejo: 'Sin tablas, cajas de texto ni columnas múltiples.', needsText: true, run: ruleSingleColumn },
  { id: 2, titulo: 'Encabezados de sección estándar', consejo: 'Usa "Experiencia", "Educación", "Habilidades".', needsText: true, run: ruleSections },
  { id: 3, titulo: 'Keywords literales del anuncio', consejo: 'Usa los mismos términos de la vacante, no sinónimos.', needsText: true, run: ruleKeywords },
  { id: 4, titulo: 'Sin imágenes ni gráficas', consejo: 'El ATS no lee imágenes, íconos ni logos.', needsText: false, run: ruleNoImages },
  { id: 5, titulo: 'Contacto en el cuerpo del CV', consejo: 'No pongas tus datos en el encabezado/pie del documento.', needsText: true, run: ruleContact },
  { id: 6, titulo: 'PDF con texto seleccionable', consejo: 'No exportes tu CV como imagen escaneada.', needsText: false, run: ruleSelectableText },
  { id: 7, titulo: 'Tipografía estándar', consejo: 'Arial, Calibri o Times, tamaño 10-12.', needsText: false, run: ruleFonts },
  { id: 8, titulo: 'Fechas en formato consistente', consejo: 'Un solo formato (mm/aaaa) en toda la experiencia.', needsText: true, run: ruleDates },
  { id: 9, titulo: 'Nombre de archivo claro', consejo: 'Usa "Nombre-Apellido-CV.pdf".', needsText: false, run: ruleFileName },
  { id: 10, titulo: 'Verbos de acción en cada logro', consejo: 'Inicia con "Lideré", "Reduje", "Diseñé".', needsText: true, run: ruleActionVerbs },
  { id: 11, titulo: 'Sin barras ni estrellas de nivel', consejo: 'Describe el nivel con texto ("Excel avanzado").', needsText: true, run: ruleNoBars },
  { id: 12, titulo: 'Título del puesto alineado a la vacante', consejo: 'Un título claro arriba, igual al del anuncio.', needsText: true, run: ruleTitle },
];

export function evaluateAll(facts) {
  const gate = ruleSelectableText(facts);
  return CHECKLIST.map(({ id, titulo, consejo, needsText, run }) => {
    if (gate.estado === 'falla' && needsText) {
      return { id, titulo, consejo, estado: 'manual', detalle: 'No se puede evaluar: el PDF no tiene texto seleccionable.' };
    }
    const { estado, detalle } = run(facts);
    return { id, titulo, consejo, estado, detalle };
  });
}

export function computeScore(results) {
  const pasa = results.filter((r) => r.estado === 'pasa').length;
  const falla = results.filter((r) => r.estado === 'falla').length;
  const evaluables = pasa + falla;
  const pct = evaluables === 0 ? null : Math.round((pasa / evaluables) * 100);
  return { pct, pasa, falla, manual: results.length - evaluables, evaluables };
}
