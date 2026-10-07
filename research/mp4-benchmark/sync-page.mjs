/** Página de prueba de sincronía: destello blanco + pitido de 1 kHz en cada segundo exacto. */
export function syncPageUrl(TITLE) {
// Página de prueba: animación + reloj + destello/pitido sincronizados en cada segundo.
  const html = `<title>${TITLE}</title><body style="margin:0;background:#000"><canvas id=c></canvas><script>
c.width = innerWidth; c.height = innerHeight; const x = c.getContext('2d');
const ac = new AudioContext();
const beepGain = ac.createGain(); beepGain.gain.value = 0;
const beep = ac.createOscillator(); beep.frequency.value = 1000; beep.connect(beepGain).connect(ac.destination); beep.start();
const hum = ac.createOscillator(); hum.frequency.value = 220; const humGain = ac.createGain(); humGain.gain.value = 0.05;
hum.connect(humGain).connect(ac.destination); hum.start();
const t0 = performance.now(); const a0 = ac.currentTime;
for (let s = 1; s < 7200; s++) { beepGain.gain.setValueAtTime(0.8, a0 + s); beepGain.gain.setValueAtTime(0, a0 + s + 0.1); }
function draw() {
  const t = (performance.now() - t0) / 1000;
  const flash = t >= 1 && (t % 1) < 0.1;
  x.fillStyle = flash ? '#fff' : 'hsl(' + (t * 40 % 360) + ',60%,25%)';
  x.fillRect(0, 0, c.width, c.height);
  if (!flash) {
    x.fillStyle = '#fff'; x.font = 'bold 80px monospace'; x.fillText(t.toFixed(2) + ' s', 40, 120);
    for (let i = 0; i < 12; i++) {
      x.fillStyle = 'hsl(' + (i * 30) + ',80%,60%)'; x.beginPath();
      x.arc(c.width / 2 + Math.cos(t * 2 + i) * c.height / 3, c.height / 2 + Math.sin(t * 3 + i) * c.height / 3, 30, 0, 7); x.fill();
    }
  }
  requestAnimationFrame(draw);
}
draw();
</script>`;
  return 'data:text/html,' + encodeURIComponent(html);
}
