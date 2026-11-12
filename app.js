(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const forge = window.forge;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  let cert = null; // {key, cert, wwdr, passTypeId, teamId}

  const FIELD_DEFS = [
    ['pnr', 'PNR'], ['trainNo', 'Train no.'], ['trainName', 'Train name'], ['cls', 'Class'],
    ['date', 'Journey date'], ['depTime', 'Departure'], ['from', 'From (station)'], ['fromCode', 'From code'],
    ['to', 'To (station)'], ['toCode', 'To code'], ['quota', 'Quota'], ['coach', 'Coach / berth'],
  ];

  // ---------- helpers ----------
  const setMsg = (id, text, cls) => { const e = $(id); e.textContent = text || ''; e.className = 'msg ' + (cls || ''); };
  const u8ToBin = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
  const binToU8 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const readBin = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(u8ToBin(new Uint8Array(r.result))); r.onerror = rej; r.readAsArrayBuffer(file); });
  const b64 = (s) => btoa(s);

  function parseCertFile(bin) {
    if (bin.indexOf('-----BEGIN') !== -1) return forge.pki.certificateFromPem(bin);
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(bin));
  }

  // ---------- certificate ----------
  async function loadCertFrom(p12bin, pw, wwdrBin) {
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(p12bin), pw);
    const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
      || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
    if (!keyBags.length || !bags.length) throw new Error('No key or certificate found in the .p12');
    const key = keyBags[0].key;
    // pick the cert whose public key matches the private key
    let leaf = bags.map((b) => b.cert).find((c) => c.publicKey.n && key.n && c.publicKey.n.compareTo(key.n) === 0) || bags[0].cert;
    const uid = leaf.subject.attributes.find((a) => a.type === '0.9.2342.19200300.100.1.1');
    const ou = leaf.subject.getField('OU');
    const wwdr = parseCertFile(wwdrBin);
    return { key, cert: leaf, wwdr, passTypeId: uid ? uid.value : '', teamId: ou ? ou.value : '' };
  }

  function showCert(c) {
    cert = c;
    $('certState').textContent = 'loaded';
    $('certState').className = 'tag ok';
    setMsg('certMsg', 'Pass Type ID: ' + (c.passTypeId || 'unknown') + '  |  Team: ' + (c.teamId || 'unknown'), 'ok');
  }

  $('loadCert').onclick = async () => {
    try {
      const f = $('p12').files[0], w = $('wwdr').files[0];
      if (!f || !w) throw new Error('Choose both the .p12 and the WWDR certificate');
      const p12bin = await readBin(f), wwdrBin = await readBin(w), pw = $('p12pw').value;
      showCert(await loadCertFrom(p12bin, pw, wwdrBin));
      if ($('remember').checked) {
        try { localStorage.setItem('t2w', JSON.stringify({ p12: b64(p12bin), pw, wwdr: b64(wwdrBin) })); } catch (e) {}
      }
    } catch (e) { setMsg('certMsg', 'Could not load: ' + e.message, 'err'); }
  };

  (async function restore() {
    try {
      const s = JSON.parse(localStorage.getItem('t2w') || 'null');
      if (s) showCert(await loadCertFrom(atob(s.p12), s.pw, atob(s.wwdr)));
    } catch (e) { /* ignore */ }
  })();

  // ---------- ticket parsing ----------
  async function readPdf(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let text = '', qr = null;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      text += tc.items.map((i) => i.str).join(' ') + '\n';
      if (!qr) {
        for (const scale of [3, 2, 4]) {
          const vp = page.getViewport({ scale });
          const cv = document.createElement('canvas');
          cv.width = vp.width; cv.height = vp.height;
          await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
          qr = scanQR(cv); if (qr) break;
        }
      }
    }
    return { text: text.replace(/\s+/g, ' '), qr };
  }

  function scanQR(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
  }

  async function readImage(file) {
    const bmp = await createImageBitmap(file);
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    return { text: '', qr: scanQR(cv) };
  }

  function parseTicket(t) {
    const m = (re, i) => { const r = t.match(re); return r ? (r[i || 1] || '').trim() : ''; };
    const o = {};
    o.pnr = m(/PNR\s*(?:No\.?)?\s*[:\-]?\s*(\d{10})/i) || m(/\b(\d{10})\b/);
    const tr = t.match(/Train\s*No\.?\s*(?:\/|&)?\s*Name\s*[:\-]?\s*(\d{5})\s*[\/\-]?\s*([A-Z0-9 .\-]+?)(?=\s{0,2}(?:Class|Quota|Date|Distance|Boarding|From|$))/i)
      || t.match(/(\d{5})\s*\/\s*([A-Z][A-Z0-9 .\-]{2,30}?)(?=\s+(?:Class|Quota|Date|Distance|From|Start))/);
    o.trainNo = tr ? tr[1] : ''; o.trainName = tr ? tr[2].trim() : '';
    const stop = '(?=\\s+(?:Quota|Date|Distance|Boarding|From|Train|Start|PNR|Class|Scheduled|Departure)\\b|$)';
    const cl = m(new RegExp('Class\\s*[:\\-]?\\s*(.+?)' + stop));
    const cc = cl.match(/\(([A-Z0-9]{1,3})\)/); o.cls = cc ? cc[1] : cl;
    const qu = m(new RegExp('Quota\\s*[:\\-]?\\s*(.+?)' + stop));
    const qc = qu.match(/\(([A-Z]{2,4})\)/); o.quota = qc ? qu.replace(/\s*\(.*$/, '') + ' (' + qc[1] + ')' : qu;
    o.date = m(/Date\s*of\s*Journey\s*[:\-]?\s*(\d{1,2}[-\/ ][A-Za-z]{3}[-\/ ]\d{4}|\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i)
      || m(/Start\s*Date\s*[:\-]?\s*(\d{1,2}[-\/ ][A-Za-z]{3}[-\/ ]\d{4})/i);
    o.depTime = m(/(?:Scheduled\s*)?Departure\s*[:\-]?\s*(?:\*\s*)?(\d{1,2}:\d{2})/i);
    const st = (label) => {
      const r = t.match(new RegExp(label + '\\s*[:\\-]?\\s*([A-Z][A-Za-z .\\-]+?)\\s*\\(\\s*([A-Z]{2,5})\\s*\\)', 'i'));
      return r ? [r[1].trim(), r[2].toUpperCase()] : ['', ''];
    };
    let [bn, bc] = st('Boarding\\s*At'); let [fn, fc] = st('From'); let [tn, tc] = st('To');
    if (!fn) { fn = bn; fc = bc; }
    o.from = fn; o.fromCode = fc; o.to = tn; o.toCode = tc;
    o.coach = m(/\b((?:[A-Z]{1,2}\d{1,2})\s*,\s*\d{1,3}\s*,?\s*[A-Z]{0,3})\b/);
    // passengers: lines like "1. NAME 28 Male CNF/B2/45"
    const names = [];
    const re = /(?:^|\s)\d{1,2}\.?\s+([A-Z][A-Za-z .]{2,30}?)\s+(\d{1,3})\s+(Male|Female|M|F|Transgender|T)\b\s*([A-Z]{2,4}\/[A-Z0-9]+\/\d+[A-Z]*(?:,\s*[A-Z]+)?|CNF[^ ]*|RAC[^ ]*|WL[^ ]*)?/g;
    let x; while ((x = re.exec(t)) && names.length < 6) names.push((x[1].trim() + ' (' + x[2] + ', ' + x[3] + ')' + (x[4] ? ' ' + x[4] : '')));
    o.passengers = names.join('\n');
    return o;
  }

  function buildFields(vals) {
    const box = $('fields'); box.innerHTML = '';
    FIELD_DEFS.forEach(([k, label]) => {
      const l = document.createElement('label'); l.textContent = label;
      const i = document.createElement('input'); i.type = 'text'; i.id = 'f_' + k; i.value = vals[k] || '';
      l.appendChild(i); box.appendChild(l);
    });
  }

  async function onTicket(file) {
    setMsg('pdfMsg', 'Reading ticket...');
    $('dl').hidden = true;
    try {
      const r = file.type.startsWith('image/') ? await readImage(file) : await readPdf(file);
      const v = parseTicket(r.text);
      buildFields(v);
      $('passengers').value = v.passengers || '';
      $('qrdata').value = r.qr || '';
      $('qrHint').textContent = r.qr ? 'QR code found and will be reused, so TTEs can scan it from Wallet.' : 'No QR code detected. The PNR will be used as the barcode. Paste the QR content above if you have it.';
      $('editCard').hidden = false;
      const got = FIELD_DEFS.filter(([k]) => v[k]).length;
      setMsg('pdfMsg', 'Read ' + got + ' of ' + FIELD_DEFS.length + ' fields. Please check and fix anything below.', got > 3 ? 'ok' : 'err');
    } catch (e) { setMsg('pdfMsg', 'Could not read file: ' + e.message, 'err'); }
  }
  $('pdf').onchange = (e) => e.target.files[0] && onTicket(e.target.files[0]);

  // ---------- pass building ----------
  function iconPng(size) {
    return new Promise((res) => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d'), s = size / 100;
      g.fillStyle = '#1b5e9e'; g.fillRect(0, 0, size, size);
      g.fillStyle = '#fff';
      g.beginPath(); g.roundRect ? g.roundRect(24 * s, 14 * s, 52 * s, 60 * s, 10 * s) : g.rect(24 * s, 14 * s, 52 * s, 60 * s); g.fill();
      g.fillStyle = '#1b5e9e'; g.fillRect(31 * s, 24 * s, 38 * s, 20 * s);
      g.fillStyle = '#1b5e9e'; g.beginPath(); g.arc(36 * s, 60 * s, 4.5 * s, 0, 7); g.arc(64 * s, 60 * s, 4.5 * s, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.fillRect(28 * s, 80 * s, 10 * s, 8 * s); g.fillRect(62 * s, 80 * s, 10 * s, 8 * s);
      c.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))));
    });
  }

  function relevantDate(date, time) {
    const mon = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    let d = date.match(/(\d{1,2})[-\/ ]([A-Za-z]{3})[A-Za-z]*[-\/ ](\d{4})/);
    let day, month, year;
    if (d) { day = +d[1]; month = mon[d[2].toLowerCase()]; year = +d[3]; }
    else { d = date.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/); if (!d) return null; day = +d[1]; month = +d[2]; year = +d[3]; }
    if (!month) return null;
    const t = (time || '00:00').split(':');
    const p = (n) => String(n).padStart(2, '0');
    return year + '-' + p(month) + '-' + p(day) + 'T' + p(+t[0]) + ':' + p(+t[1]) + ':00+05:30';
  }

  async function makePass() {
    if (!cert) throw new Error('Load your signing certificate first (step 1)');
    const v = {}; FIELD_DEFS.forEach(([k]) => (v[k] = $('f_' + k).value.trim()));
    if (!v.pnr) throw new Error('PNR is required');
    const passengers = $('passengers').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const qr = $('qrdata').value.trim() || v.pnr;

    const pass = {
      formatVersion: 1,
      passTypeIdentifier: cert.passTypeId,
      teamIdentifier: cert.teamId,
      serialNumber: v.pnr + '-' + Date.now().toString(36),
      organizationName: 'IRCTC',
      description: 'IRCTC train ticket',
      logoText: 'IRCTC',
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: 'rgb(27,94,158)',
      labelColor: 'rgb(200,222,245)',
      barcodes: [{ format: 'PKBarcodeFormatQR', message: qr, messageEncoding: 'iso-8859-1', altText: 'PNR ' + v.pnr }],
      barcode: { format: 'PKBarcodeFormatQR', message: qr, messageEncoding: 'iso-8859-1', altText: 'PNR ' + v.pnr },
      boardingPass: {
        transitType: 'PKTransitTypeTrain',
        headerFields: [{ key: 'pnr', label: 'PNR', value: v.pnr }],
        primaryFields: [
          { key: 'from', label: v.from || 'FROM', value: v.fromCode || v.from || '-' },
          { key: 'to', label: v.to || 'TO', value: v.toCode || v.to || '-' },
        ],
        secondaryFields: [
          { key: 'train', label: 'TRAIN', value: [v.trainNo, v.trainName].filter(Boolean).join(' ') || '-' },
          { key: 'date', label: 'DATE', value: v.date || '-' },
        ],
        auxiliaryFields: [
          { key: 'cls', label: 'CLASS', value: v.cls || '-' },
          { key: 'dep', label: 'DEPARTS', value: v.depTime || '-' },
          { key: 'coach', label: 'COACH / BERTH', value: v.coach || '-' },
        ],
        backFields: [
          { key: 'pax', label: 'Passengers', value: passengers.join('\n') || '-' },
          { key: 'quota', label: 'Quota', value: v.quota || '-' },
          { key: 'note', label: 'Note', value: 'Unofficial copy. Carry valid ID proof for the journey.' },
        ],
      },
    };
    const rd = relevantDate(v.date, v.depTime); if (rd) pass.relevantDate = rd;

    const files = { 'pass.json': binToU8(unescape(encodeURIComponent(JSON.stringify(pass)))) };
    for (const [n, sz] of [['icon.png', 29], ['icon@2x.png', 58], ['icon@3x.png', 87]]) files[n] = await iconPng(sz);
    files['logo.png'] = await iconPng(50); files['logo@2x.png'] = await iconPng(100);

    const manifest = {};
    for (const n in files) { const md = forge.md.sha1.create(); md.update(u8ToBin(files[n])); manifest[n] = md.digest().toHex(); }
    const manifestStr = JSON.stringify(manifest);

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(manifestStr, 'utf8');
    p7.addCertificate(cert.cert); p7.addCertificate(cert.wwdr);
    p7.addSigner({
      key: cert.key, certificate: cert.cert, digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: new Date() },
      ],
    });
    p7.sign({ detached: true });
    const sig = forge.asn1.toDer(p7.toAsn1()).getBytes();

    const zip = new JSZip();
    for (const n in files) zip.file(n, files[n]);
    zip.file('manifest.json', manifestStr);
    zip.file('signature', binToU8(sig));
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.apple.pkpass', compression: 'DEFLATE' });
  }

  $('make').onclick = async () => {
    setMsg('makeMsg', 'Signing...');
    try {
      const blob = await makePass();
      const a = $('dl');
      if (a.dataset.url) URL.revokeObjectURL(a.dataset.url);
      a.dataset.url = a.href = URL.createObjectURL(blob);
      a.download = 'ticket-' + ($('f_pnr').value || 'irctc') + '.pkpass';
      a.hidden = false;
      setMsg('makeMsg', 'Done. Tap download, then "Add" in Wallet.', 'ok');
    } catch (e) { setMsg('makeMsg', e.message, 'err'); }
  };
})();
