// Cuenta paquetes de vídeo (solo demux, sin decodificar) con Mediabunny en Node.
const MB = require('mediabunny');
const fs = require('node:fs');
(async () => {
  for (const f of process.argv.slice(2)) {
    const input = new MB.Input({ source: new MB.BufferSource(fs.readFileSync(f)), formats: MB.ALL_FORMATS });
    const t = await input.getPrimaryVideoTrack();
    const s = await t.computePacketStats();
    // ¿Timestamps duplicados o casi duplicados en la entrada?
    let dup = 0, prev = null, minGapMs = Infinity;
    for await (const p of new MB.EncodedPacketSink(t).packets(undefined, undefined, { metadataOnly: true })) {
      if (prev !== null) { const g = (p.timestamp - prev) * 1000; if (g < 1) dup++; minGapMs = Math.min(minGapMs, g); }
      prev = p.timestamp;
    }
    console.log(`${f.split('/').pop().padEnd(48)} ${String(s.packetCount).padStart(6)} paquetes · ${s.averagePacketRate.toFixed(1)} fps · huecos <1 ms: ${dup} · hueco mínimo ${minGapMs.toFixed(2)} ms`);
  }
})();
