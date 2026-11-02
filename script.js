// ====== FILE: script.js ======
const video = document.getElementById('video');
const overlay = document.getElementById('canvasOverlay');
const hiddenCanvas = document.getElementById('hiddenCanvas');
const startBtn = document.getElementById('startBtn');
const switchBtn = document.getElementById('switchBtn');
const cameraSelect = document.getElementById('cameraSelect');
const resultLabel = document.getElementById('resultLabel');
const resultDetail = document.getElementById('resultDetail');
const colorSwatch = document.getElementById('colorSwatch');

let currentStream = null;
let videoDevices = [];
let currentDeviceIndex = 0;
let detectInterval = null;
let overlayStarted = false;

// Kotak hasil pelacakan (koordinat piksel video asli). null = belum ada cabai.
let trackedBox = null;
let lastLabelColor = '#ffffff';

// --- PENGATURAN (silakan sesuaikan angkanya) ---
const SCAN_WIDTH = 480;          // lebar gambar untuk pemindaian (kecil = cepat)
const MIN_BLOB_RATIO = 0.0007;    // gumpalan minimal 0,2% luas gambar
const MAX_BLOB_RATIO = 0.35;     // gumpalan maksimal 35% luas gambar
const MIN_DOMINAN = 60;          // warna dominan minimal 60% di dalam gumpalan
const MIN_FILL = 0.2;           // minimal 30% isi kotak gumpalan berwarna cabai
const MAX_FILL = 0.80;           // lebih padat dari ini = terlalu kotak (bukan cabai)
const MIN_ASPECT = 1.7;          // cabai itu kurus: sisi panjang / sisi pendek minimal 2
const MAX_LUBANG = 0.55;         // maksimal 55% isi kotak boleh bukan warna cabai
const SMOOTHING = 0.35;          // 0-1, makin besar kotak makin cepat mengikuti

// --- BAGIAN 1: Mendeteksi kamera yang tersedia ---
async function getCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  videoDevices = devices.filter(d => d.kind === 'videoinput');
  cameraSelect.innerHTML = '';
  videoDevices.forEach((device, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.text = device.label || 'Kamera ' + (i + 1);
    cameraSelect.appendChild(option);
  });
  cameraSelect.value = currentDeviceIndex;
}

// --- BAGIAN 2: Menyalakan kamera ---
async function startCamera(deviceId) {
  resultDetail.innerText = 'Menyalakan kamera...';
  if (currentStream) currentStream.getTracks().forEach(t => t.stop());
  const constraints = {
    video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }
  };
  try {
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    await video.play();
    await getCameras();
    startOverlay();
    startDetectionLoop();
  } catch (err) {
    resultDetail.innerText = 'Gagal mengakses kamera: ' + err.message;
  }
}

// --- BAGIAN 3: Menggambar kotak yang mengikuti cabai ---
function startOverlay() {
  if (overlayStarted) return;
  overlayStarted = true;

  function resize() {
    overlay.width = video.clientWidth;
    overlay.height = video.clientHeight;
  }
  video.addEventListener('loadedmetadata', resize);
  window.addEventListener('resize', resize);
  resize();

  function loop() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (trackedBox && video.videoWidth > 0) {
      const sx = overlay.width / video.videoWidth;
      const sy = overlay.height / video.videoHeight;
      ctx.strokeStyle = lastLabelColor;
      ctx.lineWidth = 3;
      ctx.strokeRect(trackedBox.x * sx, trackedBox.y * sy, trackedBox.w * sx, trackedBox.h * sy);
    }
    requestAnimationFrame(loop);
  }
  loop();
}

// --- BAGIAN 4: Loop deteksi ---
function startDetectionLoop() {
  if (detectInterval) clearInterval(detectInterval);
  detectInterval = setInterval(() => {
    const hasil = processImage();
    if (hasil) updateUI(hasil);
  }, 200);
}

// --- KLASIFIKASI WARNA (dikalibrasi dari foto sampel cabai) ---
// hsv.h = 0-360, hsv.s dan hsv.v = 0-1
// Ada batas kecerahan maksimal (v) karena cabai tidak pernah seterang
// kemasan, kertas, atau dinding putih. Kulit, meja, baju = null.
function klasifikasiWarna(hsv) {
  const h = hsv.h, s = hsv.s, v = hsv.v;
  if ((h >= 345 || h < 12) && s >= 0.45 && v >= 0.18 && v <= 0.85) return 'merah';
  if (h >= 12 && h < 38 && s >= 0.45 && v >= 0.18 && v <= 0.88) return 'oranye';
  if (h >= 70 && h <= 150 && s >= 0.22 && v >= 0.15 && v <= 0.72) return 'hijau';
  return null;
}

const INDEKS_KELAS = { merah: 1, oranye: 2, kuning: 3, hijau: 4 };
const NAMA_KELAS = [null, 'merah', 'oranye', 'kuning', 'hijau'];

function tolak(alasan) {
  trackedBox = null;
  alasan = alasan + ' [' + (window.debugInfo || '') + ']';
  return {
    tahap: 'Bukan cabai / tidak terdeteksi',
    warna: '#555555',
    alasan: alasan
  };
}

// --- BAGIAN 5: INTI PENGOLAHAN CITRA (pelacak otomatis) ---
function processImage() {
  if (video.videoWidth === 0) return null;

  // Perkecil gambar supaya pemindaian cepat
  const w = SCAN_WIDTH;
  const h = Math.round(video.videoHeight * (SCAN_WIDTH / video.videoWidth));
  hiddenCanvas.width = w;
  hiddenCanvas.height = h;
  const ctx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // Langkah 1: beri label kelas warna tiap piksel (0 = bukan warna cabai)
  const peta = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const kelas = klasifikasiWarna(rgbToHsv(data[i], data[i + 1], data[i + 2]));
    peta[p] = kelas ? INDEKS_KELAS[kelas] : 0;
  }

  // Langkah 2: kelompokkan piksel bertetangga jadi gumpalan (flood fill)
  const dikunjungi = new Uint8Array(w * h);
  const tumpukan = new Int32Array(w * h);
  const totalPiksel = w * h;
  let terbaik = null;

  for (let start = 0; start < totalPiksel; start++) {
    if (peta[start] === 0 || dikunjungi[start]) continue;

    let top = 0;
    tumpukan[top++] = start;
    dikunjungi[start] = 1;

    let n = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    const hitung = [0, 0, 0, 0, 0];

    while (top > 0) {
      const p = tumpukan[--top];
      const x = p % w, y = (p - x) / w;
      n++;
      hitung[peta[p]]++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // tetangga 4 arah
      if (x > 0)     { const q = p - 1; if (peta[q] && !dikunjungi[q]) { dikunjungi[q] = 1; tumpukan[top++] = q; } }
      if (x < w - 1) { const q = p + 1; if (peta[q] && !dikunjungi[q]) { dikunjungi[q] = 1; tumpukan[top++] = q; } }
      if (y > 0)     { const q = p - w; if (peta[q] && !dikunjungi[q]) { dikunjungi[q] = 1; tumpukan[top++] = q; } }
      if (y < h - 1) { const q = p + w; if (peta[q] && !dikunjungi[q]) { dikunjungi[q] = 1; tumpukan[top++] = q; } }
    }

    // Langkah 3: saring gumpalan, hanya yang ukuran dan bentuknya mirip cabai
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const kotakLuas = bw * bh;
    window.debugInfo = 'n=' + n + ' aspek=' + (Math.max(bw, bh) / Math.min(bw, bh)).toFixed(1) + ' isi=' + (n / kotakLuas).toFixed(2);
    
    // ukuran wajar
    const rasioLuas = n / totalPiksel;
    if (rasioLuas < MIN_BLOB_RATIO || rasioLuas > MAX_BLOB_RATIO) continue;

    // kepadatan isi kotak
    const isi = n / kotakLuas;
    if (isi < MIN_FILL || isi > MAX_FILL) continue;

    // bentuk harus kurus dan panjang
    const aspek = Math.max(bw, bh) / Math.min(bw, bh);
    if (aspek < MIN_ASPECT) continue;

    // warna dominan di dalam gumpalan
    let kelasDominan = 1;
    for (let k = 2; k <= 4; k++) if (hitung[k] > hitung[kelasDominan]) kelasDominan = k;
    const persen = Math.round((hitung[kelasDominan] / n) * 100);
    if (persen < MIN_DOMINAN) continue;

    // tolak benda yang punya banyak "lubang" (tulisan, gambar, logo).
    // Cabai asli hampir tidak punya lubang.
    let lubang = 0;
    for (let yy = minY; yy <= maxY; yy++) {
      for (let xx = minX; xx <= maxX; xx++) {
        if (peta[yy * w + xx] === 0) lubang++;
      }
    }
    if (lubang / kotakLuas > MAX_LUBANG) continue;

    if (!terbaik || n > terbaik.n) {
      terbaik = { n, minX, minY, bw, bh, kelasDominan, persen };
    }
  }

  if (!terbaik) {
    return tolak('Cabai tidak terdeteksi. Tunjukkan cabai ke kamera dengan latar yang polos.');
  }

  // Langkah 4: hitung rata-rata HSV hanya di dalam kotak cabai
  let sumH = 0, sumS = 0, sumV = 0, cnt = 0;
  const kelasTarget = terbaik.kelasDominan;
  for (let y = terbaik.minY; y < terbaik.minY + terbaik.bh; y++) {
    for (let x = terbaik.minX; x < terbaik.minX + terbaik.bw; x++) {
      const p = y * w + x;
      if (peta[p] !== kelasTarget) continue;
      const i = p * 4;
      const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      sumH += (hsv.h > 180 ? hsv.h - 360 : hsv.h); // hue merah melingkar
      sumS += hsv.s;
      sumV += hsv.v;
      cnt++;
    }
  }
  let avgH = Math.round(sumH / cnt);
  if (avgH < 0) avgH += 360;

  // Langkah 5: gerakkan kotak ke posisi cabai (dihaluskan supaya tidak bergetar)
  const skala = video.videoWidth / w;
  const target = {
    x: terbaik.minX * skala,
    y: terbaik.minY * skala,
    w: terbaik.bw * skala,
    h: terbaik.bh * skala
  };
  if (!trackedBox) {
    trackedBox = target;
  } else {
    trackedBox.x += (target.x - trackedBox.x) * SMOOTHING;
    trackedBox.y += (target.y - trackedBox.y) * SMOOTHING;
    trackedBox.w += (target.w - trackedBox.w) * SMOOTHING;
    trackedBox.h += (target.h - trackedBox.h) * SMOOTHING;
  }

  const label = {
    hijau:  { tahap: 'Hijau - Belum Matang',     warna: '#2d6a4f' },
    kuning: { tahap: 'Kuning - Hampir Matang',   warna: '#e6c619' },
    oranye: { tahap: 'Oranye - Setengah Matang', warna: '#e8780a' },
    merah:  { tahap: 'Merah - Matang',           warna: '#c1121f' }
  }[NAMA_KELAS[kelasTarget]];

  return {
    ...label,
    persentase: terbaik.persen,
    avgH: avgH,
    avgS: Math.round((sumS / cnt) * 100),
    avgV: Math.round((sumV / cnt) * 100)
  };
}

// --- BAGIAN 6: Konversi RGB ke HSV ---
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

// --- BAGIAN 7: Menampilkan hasil ---
function updateUI(hasil) {
  resultLabel.innerText = hasil.tahap;
  colorSwatch.style.background = hasil.warna;
  lastLabelColor = hasil.alasan ? '#ffffff' : hasil.warna;
  if (hasil.alasan) {
    resultDetail.innerText = hasil.alasan;
    return;
  }
  resultDetail.innerText = 'Dominan ' + hasil.persentase + '% · H:' + hasil.avgH + '° S:' + hasil.avgS + '% V:' + hasil.avgV + '%';
}

// --- BAGIAN 8: Menghubungkan tombol ---
startBtn.addEventListener('click', () => startCamera());
switchBtn.addEventListener('click', () => {
  if (videoDevices.length === 0) return;
  currentDeviceIndex = (currentDeviceIndex + 1) % videoDevices.length;
  startCamera(videoDevices[currentDeviceIndex].deviceId);
});
cameraSelect.addEventListener('change', (e) => {
  currentDeviceIndex = parseInt(e.target.value);
  startCamera(videoDevices[currentDeviceIndex].deviceId);
});
getCameras();