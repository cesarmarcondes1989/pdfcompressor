/* Compressor / separador de PDF — processamento 100% no navegador (pdf.js + pdf-lib) */
(() => {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

  const LEVELS = [
    { id: 'leve',   name: 'Leve',   desc: 'Qualidade quase intacta', dpi: 150, quality: 0.86 },
    { id: 'media',  name: 'Média',  desc: 'Equilíbrio recomendado',  dpi: 120, quality: 0.72 },
    { id: 'forte',  name: 'Forte',  desc: 'Ótimo para e-mail',       dpi: 96,  quality: 0.58 },
    { id: 'maxima', name: 'Máxima', desc: 'Menor tamanho possível',  dpi: 72,  quality: 0.42, max: true },
  ];
  const MAX_PIXELS = 4_000_000; // teto de segurança por página

  const $ = (id) => document.getElementById(id);
  const el = {
    dropzone: $('dropzone'), fileInput: $('fileInput'), workspace: $('workspace'),
    fileName: $('fileName'), pageCount: $('pageCount'), originalSize: $('originalSize'),
    analysisBar: $('analysisBar'), analysisText: $('analysisText'), levels: $('levels'),
    grayscale: $('grayscale'), summary: $('summary'), sumBefore: $('sumBefore'),
    sumAfter: $('sumAfter'), sumSaving: $('sumSaving'), sumEstTag: $('sumEstTag'),
    sumAfterLabel: $('sumAfterLabel'), compressBtn: $('compressBtn'), downloadBtn: $('downloadBtn'),
    progress: $('progress'), barFill: $('barFill'), progressText: $('progressText'),
    error: $('error'), resetBtn: $('resetBtn'), rangeInput: $('rangeInput'),
    pageGrid: $('pageGrid'), pageSelCount: $('pageSelCount'), modes: $('modes'),
    compressOptions: $('compressOptions'),
  };

  const state = {
    file: null, pdf: null, bytes: null, pageTotal: 0,
    selectedPages: new Set(),
    mode: 'compress',              // 'compress' | 'split'
    perPage: {},                   // "levelId|gray" -> bytes médios por página
    splitSize: null,               // tamanho real do PDF só com as páginas selecionadas
    selectedLevel: 'media',
    analysisToken: 0,
    resultUrl: null,
    busy: false,
  };

  /* ---------- utilidades ---------- */
  const formatBytes = (b) => {
    if (b === null || b === undefined || Number.isNaN(b)) return '–';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  };
  const savingPct = (before, after) => Math.round((1 - after / before) * 100);
  const gkey = (levelId) => levelId + '|' + (el.grayscale.checked ? 'g' : 'c');
  const sleep = () => new Promise((r) => setTimeout(r, 0));
  const sortedSelection = () => [...state.selectedPages].sort((a, b) => a - b);

  const showError = (msg) => { el.error.textContent = msg; el.error.hidden = false; };
  const clearError = () => { el.error.hidden = true; };

  /* ---------- intervalos de páginas ---------- */
  function parseRanges(text, total) {
    const pages = new Set();
    for (const part of text.split(/[,;]/)) {
      const chunk = part.trim();
      if (!chunk) continue;
      const m = chunk.match(/^(\d+)\s*(?:-|–|a|até)\s*(\d+)$/i);
      if (m) {
        let [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
        if (a > b) [a, b] = [b, a];
        for (let i = Math.max(1, a); i <= Math.min(total, b); i++) pages.add(i);
      } else if (/^\d+$/.test(chunk)) {
        const n = parseInt(chunk, 10);
        if (n >= 1 && n <= total) pages.add(n);
      }
    }
    return pages;
  }

  function formatRanges(pages) {
    const list = [...pages].sort((a, b) => a - b);
    if (!list.length) return '';
    const out = [];
    let start = list[0], prev = list[0];
    for (let i = 1; i <= list.length; i++) {
      const cur = list[i];
      if (cur !== prev + 1) {
        out.push(start === prev ? String(start) : `${start}-${prev}`);
        start = cur;
      }
      prev = cur;
    }
    return out.join(', ');
  }

  /* ---------- núcleo: página -> JPEG ---------- */
  async function pageToJpeg(page, level, grayscale) {
    const base = page.getViewport({ scale: 1 });
    let scale = level.dpi / 72;
    if (base.width * base.height * scale * scale > MAX_PIXELS) {
      scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
    }
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;

    if (grayscale) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);
    }

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', level.quality));
    canvas.width = canvas.height = 0; // libera memória
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: base.width, height: base.height };
  }

  async function buildCompressed(pageNumbers, level, grayscale, onProgress) {
    const out = await PDFLib.PDFDocument.create();
    for (let i = 0; i < pageNumbers.length; i++) {
      const page = await state.pdf.getPage(pageNumbers[i]);
      const jpeg = await pageToJpeg(page, level, grayscale);
      const image = await out.embedJpg(jpeg.bytes);
      const p = out.addPage([jpeg.width, jpeg.height]);
      p.drawImage(image, { x: 0, y: 0, width: jpeg.width, height: jpeg.height });
      page.cleanup();
      if (onProgress) onProgress(i + 1, pageNumbers.length);
      await sleep(); // mantém a interface responsiva
    }
    return out.save({ useObjectStreams: true });
  }

  /* Extrai páginas sem recomprimir (quebrar o PDF) */
  async function buildSplit(pageNumbers) {
    const src = await PDFLib.PDFDocument.load(state.bytes, { ignoreEncryption: true });
    const out = await PDFLib.PDFDocument.create();
    const copied = await out.copyPages(src, pageNumbers.map((n) => n - 1));
    copied.forEach((p) => out.addPage(p));
    return out.save({ useObjectStreams: true });
  }

  /* ---------- estimativas ---------- */
  function samplePages(list) {
    const n = Math.min(3, list.length);
    const idx = new Set();
    for (let i = 0; i < n; i++) idx.add(Math.floor(((i + 0.5) / n) * list.length));
    return [...idx].map((i) => list[i]);
  }

  async function analyze() {
    const token = ++state.analysisToken;
    const selection = sortedSelection();
    if (!selection.length) {
      el.analysisBar.classList.add('done');
      el.analysisText.textContent = 'Selecione ao menos uma página para ver as estimativas.';
      renderLevels();
      return;
    }
    const gray = el.grayscale.checked;
    const sample = samplePages(selection);
    el.analysisBar.classList.remove('done');
    el.analysisText.textContent = 'Analisando o quanto dá para comprimir…';

    for (const level of LEVELS) {
      const k = level.id + '|' + (gray ? 'g' : 'c');
      if (state.perPage[k] === undefined) {
        try {
          const bytes = await buildCompressed(sample, level, gray);
          if (token !== state.analysisToken) return;
          state.perPage[k] = bytes.length / sample.length;
        } catch (err) {
          console.error(err);
          state.perPage[k] = null;
        }
      }
      if (token !== state.analysisToken) return;
      renderLevels();
      updateSummary();
    }

    const best = estimateFor('maxima');
    el.analysisBar.classList.add('done');
    if (!best) {
      el.analysisText.textContent = 'Não foi possível estimar todos os níveis.';
    } else if (best >= state.file.size) {
      el.analysisText.textContent =
        'Este PDF já está bem otimizado: nenhum nível reduz o tamanho. Use o modo "somente separar" para extrair páginas sem perder qualidade.';
    } else {
      el.analysisText.textContent =
        `Compressão máxima possível: ${formatBytes(best)} (${savingPct(state.file.size, best)}% menor que o original).`;
    }
  }

  function estimateFor(levelId) {
    const per = state.perPage[gkey(levelId)];
    if (per === undefined || per === null || state.selectedPages.size === 0) return null;
    return Math.round(per * state.selectedPages.size);
  }

  /* Tamanho real da extração (modo separar), calculado sob demanda */
  async function measureSplit() {
    const token = ++state.analysisToken;
    const selection = sortedSelection();
    state.splitSize = null;
    if (!selection.length) {
      el.analysisBar.classList.add('done');
      el.analysisText.textContent = 'Selecione ao menos uma página para ver as estimativas.';
      return;
    }
    el.analysisBar.classList.remove('done');
    el.analysisText.textContent = 'Calculando o tamanho do PDF gerado…';
    try {
      const bytes = await buildSplit(selection);
      if (token !== state.analysisToken) return;
      state.splitSize = bytes.length;
      el.analysisText.textContent =
        `PDF com ${selection.length} página(s): ${formatBytes(state.splitSize)}, sem perda de qualidade.`;
    } catch (err) {
      console.error(err);
      el.analysisText.textContent = 'Não foi possível calcular o tamanho da extração.';
    }
    el.analysisBar.classList.add('done');
    updateSummary();
  }

  /* ---------- interface ---------- */
  function renderPageGrid() {
    el.pageGrid.innerHTML = '';
    for (let n = 1; n <= state.pageTotal; n++) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'pagechip';
      chip.textContent = n;
      chip.setAttribute('aria-pressed', String(state.selectedPages.has(n)));
      chip.title = 'Página ' + n;
      chip.addEventListener('click', () => {
        if (state.busy) return;
        if (state.selectedPages.has(n)) state.selectedPages.delete(n);
        else state.selectedPages.add(n);
        onSelectionChanged();
      });
      el.pageGrid.appendChild(chip);
    }
  }

  function syncPageUI() {
    [...el.pageGrid.children].forEach((chip, i) =>
      chip.setAttribute('aria-pressed', String(state.selectedPages.has(i + 1))));
    if (document.activeElement !== el.rangeInput) {
      el.rangeInput.value = formatRanges(state.selectedPages);
    }
    const n = state.selectedPages.size;
    el.pageSelCount.innerHTML = n
      ? `<strong>${n}</strong> de ${state.pageTotal} página(s) selecionada(s)` +
        (n < state.pageTotal ? ' · o PDF gerado terá apenas essas páginas' : '')
      : 'Nenhuma página selecionada';
  }

  function renderLevels() {
    el.levels.innerHTML = '';
    for (const level of LEVELS) {
      const noPages = state.selectedPages.size === 0;
      const raw = state.perPage[gkey(level.id)];
      const est = noPages ? null : raw === undefined ? undefined : raw === null ? null : estimateFor(level.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'level';
      btn.setAttribute('aria-pressed', String(state.selectedLevel === level.id));
      btn.innerHTML = `
        <div class="lv-name">${level.name}${level.max ? '<span class="tag-max">MÁXIMO</span>' : ''}</div>
        <div class="lv-desc">${level.desc} · ${level.dpi} DPI</div>
        <div class="lv-size ${est === undefined || est === null ? 'pending' : ''}">${
          est === undefined ? 'calculando…' : est === null ? (noPages ? '–' : 'indisponível') : '~' + formatBytes(est)
        }</div>
        <div class="lv-save ${est && est >= state.file.size ? 'bad' : ''}">${
          !est || !state.file ? '' :
          est < state.file.size ? savingPct(state.file.size, est) + '% menor'
                                : 'sem ganho neste arquivo'
        }</div>`;
      btn.addEventListener('click', () => {
        if (state.busy) return;
        state.selectedLevel = level.id;
        resetResult();
        renderLevels();
        updateSummary();
      });
      el.levels.appendChild(btn);
    }
  }

  function updateSummary(realBytes) {
    if (!state.file) return;
    el.summary.hidden = false;
    el.sumBefore.textContent = formatBytes(state.file.size);
    el.sumAfterLabel.textContent = state.mode === 'split' ? 'PDF gerado' : 'Depois da compressão';
    el.sumEstTag.textContent = realBytes ? '(final)' : '(estimado)';

    const est = realBytes ?? (state.mode === 'split' ? state.splitSize : estimateFor(state.selectedLevel));
    if (state.selectedPages.size === 0 && !realBytes) {
      el.sumAfter.textContent = '–';
      el.sumSaving.textContent = '–';
      el.sumSaving.classList.remove('good');
      return;
    }
    if (est === undefined || est === null) {
      el.sumAfter.textContent = 'calculando…';
      el.sumSaving.textContent = '–';
      return;
    }
    el.sumAfter.textContent = (realBytes ? '' : '~') + formatBytes(est);
    const pct = savingPct(state.file.size, est);
    el.sumSaving.textContent = pct > 0 ? pct + '%' : 'sem ganho';
    el.sumSaving.classList.toggle('good', pct > 0);
  }

  function updateActionLabel() {
    el.compressBtn.textContent = state.mode === 'split'
      ? 'Gerar PDF com as páginas selecionadas'
      : 'Comprimir PDF';
    el.compressBtn.disabled = state.busy || state.selectedPages.size === 0;
  }

  function onSelectionChanged() {
    resetResult();
    syncPageUI();
    if (state.mode === 'split') measureSplit();
    else { renderLevels(); analyze(); }
    updateSummary();
    updateActionLabel();
  }

  function setMode(mode) {
    state.mode = mode;
    [...el.modes.children].forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    el.compressOptions.hidden = mode === 'split';
    resetResult();
    updateActionLabel();
    if (mode === 'split') measureSplit();
    else { state.analysisToken++; renderLevels(); analyze(); }
    updateSummary();
  }

  function resetResult() {
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null;
    el.downloadBtn.hidden = true;
    el.compressBtn.hidden = false;
  }

  /* ---------- fluxo principal ---------- */
  async function loadFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      showError('Selecione um arquivo PDF válido.');
      return;
    }
    clearError();
    resetResult();
    state.file = file;
    state.perPage = {};
    state.splitSize = null;
    state.selectedLevel = 'media';

    try {
      state.bytes = new Uint8Array(await file.arrayBuffer());
      // pdf.js consome o buffer: passa uma cópia para preservar o original
      state.pdf = await pdfjsLib.getDocument({ data: state.bytes.slice(0) }).promise;
    } catch (err) {
      console.error(err);
      showError('Não foi possível abrir este PDF. Ele pode estar corrompido ou protegido por senha.');
      return;
    }

    state.pageTotal = state.pdf.numPages;
    state.selectedPages = new Set(Array.from({ length: state.pageTotal }, (_, i) => i + 1));

    el.dropzone.hidden = true;
    el.workspace.hidden = false;
    el.fileName.textContent = file.name;
    el.pageCount.textContent = state.pageTotal + (state.pageTotal === 1 ? ' página' : ' páginas');
    el.originalSize.textContent = formatBytes(file.size);

    renderPageGrid();
    syncPageUI();
    setMode('compress');
  }

  async function run() {
    if (state.busy || !state.pdf) return;
    const selection = sortedSelection();
    if (!selection.length) { showError('Selecione ao menos uma página.'); return; }

    state.busy = true;
    clearError();
    resetResult();
    el.compressBtn.disabled = true;
    el.progress.hidden = false;
    el.barFill.style.width = '0%';
    el.progressText.textContent = 'Processando…';

    try {
      let bytes;
      if (state.mode === 'split') {
        bytes = await buildSplit(selection);
        el.barFill.style.width = '100%';
      } else {
        const level = LEVELS.find((l) => l.id === state.selectedLevel);
        bytes = await buildCompressed(selection, level, el.grayscale.checked, (done, total) => {
          el.barFill.style.width = (done / total) * 100 + '%';
          el.progressText.textContent = `Comprimindo página ${done} de ${total}…`;
        });
      }

      const fullDoc = selection.length === state.pageTotal;
      const useOriginal = state.mode === 'compress' && fullDoc && bytes.length >= state.file.size;
      const finalBytes = useOriginal ? state.bytes : bytes;
      const blob = new Blob([finalBytes], { type: 'application/pdf' });
      state.resultUrl = URL.createObjectURL(blob);

      const base = state.file.name.replace(/\.pdf$/i, '');
      const suffix = state.mode === 'split'
        ? (fullDoc ? '-copia' : '-paginas-' + formatRanges(state.selectedPages).replace(/[,\s]+/g, '_'))
        : '-comprimido';
      el.downloadBtn.href = state.resultUrl;
      el.downloadBtn.download = (base + suffix).slice(0, 120) + '.pdf';
      el.downloadBtn.textContent = '⬇ Baixar PDF (' + formatBytes(blob.size) + ')';
      el.downloadBtn.hidden = false;
      el.compressBtn.hidden = true;
      el.progress.hidden = true;

      updateSummary(blob.size);
      if (state.mode === 'compress') {
        state.perPage[gkey(state.selectedLevel)] = blob.size / selection.length;
        renderLevels();
      } else {
        state.splitSize = blob.size;
      }
      if (useOriginal) {
        showError('Este PDF já está bem otimizado: a compressão não reduziria o tamanho, então o arquivo original foi mantido para download.');
      }
    } catch (err) {
      console.error(err);
      el.progress.hidden = true;
      showError('Ocorreu um erro ao gerar o PDF: ' + (err && err.message ? err.message : 'erro desconhecido'));
    } finally {
      state.busy = false;
      updateActionLabel();
    }
  }

  function reset() {
    state.analysisToken++;
    resetResult();
    clearError();
    if (state.pdf) state.pdf.destroy();
    state.pdf = null; state.file = null; state.bytes = null;
    state.perPage = {}; state.splitSize = null;
    state.selectedPages = new Set();
    el.fileInput.value = '';
    el.workspace.hidden = true;
    el.dropzone.hidden = false;
    el.summary.hidden = true;
    el.progress.hidden = true;
  }


  /* ================= junção de PDFs ================= */
  const mergeEl = {
    view: $('viewMerge'), viewCompress: $('viewCompress'), tabs: $('tabs'),
    drop: $('mergeDrop'), input: $('mergeInput'), workspace: $('mergeWorkspace'),
    list: $('mergeList'), count: $('mergeCount'), pages: $('mergePages'),
    size: $('mergeSize'), sizeTag: $('mergeSizeTag'), btn: $('mergeBtn'),
    download: $('mergeDownload'), compressMerged: $('compressMergedBtn'),
    error: $('mergeError'), addMore: $('addMoreBtn'), clear: $('clearMergeBtn'),
  };

  const merge = { items: [], resultUrl: null, resultFile: null, busy: false, seq: 0 };

  const showMergeError = (msg) => { mergeEl.error.textContent = msg; mergeEl.error.hidden = false; };
  const clearMergeError = () => { mergeEl.error.hidden = true; };

  function setView(name) {
    [...mergeEl.tabs.children].forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.view === name)));
    mergeEl.viewCompress.hidden = name !== 'compress';
    mergeEl.view.hidden = name !== 'merge';
  }

  /* páginas escolhidas de um item (intervalo vazio = arquivo inteiro) */
  function itemPages(item) {
    const text = (item.range || '').trim();
    if (!text) return Array.from({ length: item.pageCount }, (_, i) => i + 1);
    return [...parseRanges(text, item.pageCount)].sort((a, b) => a - b);
  }

  async function addMergeFiles(fileList) {
    const files = [...fileList].filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!files.length) { showMergeError('Selecione ao menos um arquivo PDF.'); return; }
    clearMergeError();
    resetMergeResult();

    const rejected = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        merge.items.push({
          id: ++merge.seq, file, bytes, pageCount: doc.getPageCount(), range: '',
        });
      } catch (err) {
        console.error(err);
        rejected.push(file.name);
      }
    }
    if (rejected.length) {
      showMergeError('Não foi possível ler: ' + rejected.join(', ') +
        '. O arquivo pode estar corrompido ou protegido por senha.');
    }
    if (merge.items.length) {
      mergeEl.drop.hidden = true;
      mergeEl.workspace.hidden = false;
    }
    renderMerge();
  }

  function renderMerge() {
    mergeEl.list.innerHTML = '';
    merge.items.forEach((item, i) => {
      const pages = itemPages(item);
      const li = document.createElement('li');
      li.className = 'mergeitem';
      li.innerHTML = `
        <span class="mi-order">${i + 1}</span>
        <span class="mi-body">
          <span class="mi-name">${escapeHtml(item.file.name)}</span>
          <span class="mi-meta">${item.pageCount} página(s) · ${formatBytes(item.file.size)}${
            pages.length !== item.pageCount ? ` · usando ${pages.length} página(s)` : ''
          }</span>
        </span>`;

      const range = document.createElement('input');
      range.type = 'text';
      range.className = 'mi-range' + (item.range.trim() && !pages.length ? ' invalid' : '');
      range.placeholder = 'páginas: todas';
      range.value = item.range;
      range.title = 'Ex.: 1-3, 7 — vazio usa o arquivo inteiro';
      range.addEventListener('input', () => {
        item.range = range.value;
        resetMergeResult();
        updateMergeSummary();
        const sel = itemPages(item);
        range.classList.toggle('invalid', !!item.range.trim() && !sel.length);
        li.querySelector('.mi-meta').textContent =
          `${item.pageCount} página(s) · ${formatBytes(item.file.size)}` +
          (sel.length !== item.pageCount ? ` · usando ${sel.length} página(s)` : '');
      });

      const actions = document.createElement('span');
      actions.className = 'mi-actions';
      const mk = (label, title, disabled, fn, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'iconbtn ' + cls; b.textContent = label;
        b.title = title; b.disabled = disabled;
        b.addEventListener('click', fn);
        return b;
      };
      actions.append(
        mk('↑', 'Mover para cima', i === 0, () => moveItem(i, -1)),
        mk('↓', 'Mover para baixo', i === merge.items.length - 1, () => moveItem(i, 1)),
        mk('✕', 'Remover da lista', false, () => removeItem(i), 'danger'),
      );

      li.append(range, actions);
      mergeEl.list.appendChild(li);
    });
    updateMergeSummary();
  }

  function moveItem(i, delta) {
    if (merge.busy) return;
    const j = i + delta;
    if (j < 0 || j >= merge.items.length) return;
    [merge.items[i], merge.items[j]] = [merge.items[j], merge.items[i]];
    resetMergeResult();
    renderMerge();
  }

  function removeItem(i) {
    if (merge.busy) return;
    merge.items.splice(i, 1);
    resetMergeResult();
    if (!merge.items.length) clearMerge();
    else renderMerge();
  }

  function clearMerge() {
    merge.items = [];
    resetMergeResult();
    clearMergeError();
    mergeEl.input.value = '';
    mergeEl.list.innerHTML = '';
    mergeEl.workspace.hidden = true;
    mergeEl.drop.hidden = false;
  }

  function updateMergeSummary(realBytes) {
    const totalPages = merge.items.reduce((sum, it) => sum + itemPages(it).length, 0);
    const totalBytes = merge.items.reduce((sum, it) => sum + it.file.size, 0);
    mergeEl.count.textContent = merge.items.length;
    mergeEl.pages.textContent = totalPages;
    mergeEl.sizeTag.textContent = realBytes ? '(final)' : '(somado)';
    mergeEl.size.textContent = formatBytes(realBytes ?? totalBytes);
    mergeEl.btn.disabled = merge.busy || totalPages === 0;
  }

  function resetMergeResult() {
    if (merge.resultUrl) URL.revokeObjectURL(merge.resultUrl);
    merge.resultUrl = null;
    merge.resultFile = null;
    mergeEl.download.hidden = true;
    mergeEl.compressMerged.hidden = true;
    mergeEl.btn.hidden = false;
    mergeEl.sizeTag.textContent = '(somado)';
  }

  async function doMerge() {
    if (merge.busy || !merge.items.length) return;
    merge.busy = true;
    clearMergeError();
    resetMergeResult();
    mergeEl.btn.disabled = true;
    mergeEl.btn.textContent = 'Juntando…';

    try {
      const out = await PDFLib.PDFDocument.create();
      let used = 0;
      for (const item of merge.items) {
        const pages = itemPages(item);
        if (!pages.length) continue;
        const src = await PDFLib.PDFDocument.load(item.bytes, { ignoreEncryption: true });
        const copied = await out.copyPages(src, pages.map((n) => n - 1));
        copied.forEach((p) => out.addPage(p));
        used += pages.length;
        await sleep();
      }
      if (!used) throw new Error('nenhuma página selecionada');

      const bytes = await out.save({ useObjectStreams: true });
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const name = (merge.items[0].file.name.replace(/\.pdf$/i, '') + '-unido').slice(0, 120) + '.pdf';
      merge.resultUrl = URL.createObjectURL(blob);
      merge.resultFile = new File([blob], name, { type: 'application/pdf' });

      mergeEl.download.href = merge.resultUrl;
      mergeEl.download.download = name;
      mergeEl.download.textContent = `⬇ Baixar PDF unido (${formatBytes(blob.size)})`;
      mergeEl.download.hidden = false;
      mergeEl.compressMerged.hidden = false;
      mergeEl.btn.hidden = true;
      updateMergeSummary(blob.size);
    } catch (err) {
      console.error(err);
      showMergeError('Não foi possível juntar os arquivos: ' +
        (err && err.message ? err.message : 'erro desconhecido'));
    } finally {
      merge.busy = false;
      mergeEl.btn.textContent = 'Juntar PDFs';
      updateMergeSummary(merge.resultFile ? merge.resultFile.size : undefined);
    }
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- eventos ---------- */
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((t) =>
    el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) =>
    el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.remove('over'); }));
  el.dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 1) { setView('merge'); addMergeFiles(files); }
    else loadFile(files[0]);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  let rangeTimer;
  el.rangeInput.addEventListener('input', () => {
    if (!state.pdf || state.busy) return;
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => {
      state.selectedPages = parseRanges(el.rangeInput.value, state.pageTotal);
      onSelectionChanged();
    }, 350);
  });
  el.rangeInput.addEventListener('blur', () => syncPageUI());

  el.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode');
    if (!btn || state.busy) return;
    setMode(btn.dataset.mode);
  });

  document.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.pdf || state.busy) return;
      const q = btn.dataset.quick;
      const s = new Set();
      for (let n = 1; n <= state.pageTotal; n++) {
        if (q === 'all' || (q === 'odd' && n % 2 === 1) || (q === 'even' && n % 2 === 0)) s.add(n);
      }
      state.selectedPages = s;
      el.rangeInput.value = formatRanges(s);
      onSelectionChanged();
    });
  });

  el.grayscale.addEventListener('change', () => {
    if (state.busy || !state.pdf) return;
    resetResult();
    renderLevels();
    updateSummary();
    analyze();
  });
  el.compressBtn.addEventListener('click', run);
  el.resetBtn.addEventListener('click', reset);

  /* ---------- eventos da junção ---------- */
  mergeEl.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) setView(btn.dataset.view);
  });
  mergeEl.drop.addEventListener('click', () => mergeEl.input.click());
  mergeEl.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mergeEl.input.click(); }
  });
  mergeEl.input.addEventListener('change', (e) => {
    addMergeFiles(e.target.files);
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) =>
    mergeEl.drop.addEventListener(t, (e) => { e.preventDefault(); mergeEl.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) =>
    mergeEl.drop.addEventListener(t, (e) => { e.preventDefault(); mergeEl.drop.classList.remove('over'); }));
  mergeEl.drop.addEventListener('drop', (e) => addMergeFiles(e.dataTransfer.files));
  mergeEl.addMore.addEventListener('click', () => mergeEl.input.click());
  mergeEl.clear.addEventListener('click', clearMerge);
  mergeEl.btn.addEventListener('click', doMerge);
  mergeEl.compressMerged.addEventListener('click', () => {
    if (!merge.resultFile) return;
    setView('compress');
    loadFile(merge.resultFile);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

})();
