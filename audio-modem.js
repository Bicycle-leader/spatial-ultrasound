const TONE_FREQUENCIES = [20_300, 21_100];
const SYMBOL_SECONDS = 0.024;
const ANALYSES_PER_SYMBOL = 4;
const SYNC_BYTES = [0x96, 0xdf, 0x25];
const FRAME_BITS = (SYNC_BYTES.length + 2) * 8;
const UNKNOWN_BIT = 2;
const MIN_TONE_AMPLITUDE = 0.0004;

export function isSupportedSampleRate(sampleRate) {
  return Number.isInteger(sampleRate) && sampleRate >= 44_100 && sampleRate <= 192_000;
}

function checksum(placeId) {
  let value = placeId;
  for (let bit = 0; bit < 8; bit += 1) {
    value = ((value << 1) ^ (value & 0x80 ? 0x07 : 0)) & 0xff;
  }
  return value;
}

export function encodePlaceSignal(placeId, {
  sampleRate = 48_000,
  repeats = 2,
  amplitude = 0.28,
} = {}) {
  if (!Number.isInteger(placeId) || placeId < 1 || placeId > 255) {
    throw new RangeError("Place IDs must be integers from 1 to 255.");
  }
  if (!isSupportedSampleRate(sampleRate)) {
    throw new RangeError("The sample rate cannot carry both place signal tones.");
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 8) {
    throw new RangeError("Signal repeats must be integers from 1 to 8.");
  }
  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 1) {
    throw new RangeError("Signal amplitude must be greater than 0 and at most 1.");
  }

  const symbolSamples = Math.round(SYMBOL_SECONDS * sampleRate);
  const edgeSamples = Math.round(0.0025 * sampleRate);
  const paddingSamples = Math.round(0.048 * sampleRate);
  const gapSamples = Math.round(0.12 * sampleRate);
  const frameSamples = FRAME_BITS * symbolSamples;
  const samples = new Float32Array(
    2 * paddingSamples + repeats * frameSamples + (repeats - 1) * gapSamples,
  );

  const symbols = TONE_FREQUENCIES.map((frequency) => {
    const signal = new Float32Array(symbolSamples);
    const phaseStep = 2 * Math.PI * frequency / sampleRate;
    for (let index = 0; index < symbolSamples; index += 1) {
      const edgeDistance = Math.min(index, symbolSamples - index - 1);
      const envelope = edgeDistance < edgeSamples
        ? Math.sin(0.5 * Math.PI * edgeDistance / edgeSamples) ** 2
        : 1;
      signal[index] = amplitude * envelope * Math.sin(index * phaseStep);
    }
    return signal;
  });

  const frame = [...SYNC_BYTES, placeId, checksum(placeId)];
  let offset = paddingSamples;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const byte of frame) {
      for (let bit = 7; bit >= 0; bit -= 1) {
        samples.set(symbols[(byte >>> bit) & 1], offset);
        offset += symbolSamples;
      }
    }
    offset += gapSamples;
  }
  return samples;
}

export function encodeWav(samples, sampleRate = 48_000) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("WAV samples must be a Float32Array.");
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 192_000) {
    throw new RangeError("WAV sample rate must be an integer from 1 to 192000.");
  }

  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  if (dataSize > 0xffffffff - 36) {
    throw new RangeError("The samples are too large for a WAV file.");
  }
  const wav = new ArrayBuffer(dataSize + 44);
  const view = new DataView(wav);
  view.setUint32(0, 0x52494646); // RIFF
  view.setUint32(4, dataSize + 36, true);
  view.setUint32(8, 0x57415645); // WAVE
  view.setUint32(12, 0x666d7420); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  view.setUint32(36, 0x64617461); // data
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * bytesPerSample, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return wav;
}

export class PlaceSignalDecoder {
  constructor(sampleRate, onPlaceId) {
    if (!isSupportedSampleRate(sampleRate)) {
      throw new RangeError("The microphone sample rate cannot carry both place signal tones.");
    }
    if (typeof onPlaceId !== "function") {
      throw new TypeError("A place signal callback is required.");
    }

    this.onPlaceId = onPlaceId;
    this.hopSamples = Math.round(SYMBOL_SECONDS * sampleRate / ANALYSES_PER_SYMBOL);
    const windowSamples = Math.round(0.75 * SYMBOL_SECONDS * sampleRate);
    this.samples = new Float32Array(windowSamples);
    this.window = Float64Array.from(
      this.samples,
      (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (windowSamples - 1)),
    );

    // The neighboring bins reject broadband energy without depending on speech volume.
    const frequencies = [
      ...TONE_FREQUENCIES,
      ...TONE_FREQUENCIES.flatMap((frequency) => [frequency - 250, frequency + 250]),
    ];
    this.coefficients = frequencies.map((frequency) => 2 * Math.cos(2 * Math.PI * frequency / sampleRate));
    this.previous = new Float64Array(frequencies.length);
    this.previousPrevious = new Float64Array(frequencies.length);
    this.powers = new Float64Array(frequencies.length);
    const windowSum = this.window.reduce((sum, value) => sum + value, 0);
    this.minimumPower = (windowSum * MIN_TONE_AMPLITUDE / 2) ** 2;
    this.history = new Uint8Array(FRAME_BITS * ANALYSES_PER_SYMBOL);
    this.reset();
  }

  reset() {
    this.sampleCursor = 0;
    this.samplesUntilAnalysis = this.samples.length;
    this.analyses = 0;
    this.lastFrameAnalysis = -Infinity;
    this.history.fill(UNKNOWN_BIT);
  }

  push(samples) {
    for (const sample of samples) {
      this.samples[this.sampleCursor] = sample;
      this.sampleCursor += 1;
      if (this.sampleCursor === this.samples.length) {
        this.sampleCursor = 0;
      }

      this.samplesUntilAnalysis -= 1;
      if (this.samplesUntilAnalysis === 0) {
        this.samplesUntilAnalysis = this.hopSamples;
        this.analyze();
      }
    }
  }

  analyze() {
    const analysis = this.analyses;
    this.analyses += 1;
    const bit = this.detectTone();
    this.history[analysis % this.history.length] = bit;
    if (bit === UNKNOWN_BIT || analysis - this.lastFrameAnalysis < ANALYSES_PER_SYMBOL * 2) {
      return;
    }

    let offset = analysis - (FRAME_BITS - 1) * ANALYSES_PER_SYMBOL;
    if (offset < 0) {
      return;
    }

    for (const byte of SYNC_BYTES) {
      for (let bitIndex = 7; bitIndex >= 0; bitIndex -= 1) {
        if (this.history[offset % this.history.length] !== ((byte >>> bitIndex) & 1)) {
          return;
        }
        offset += ANALYSES_PER_SYMBOL;
      }
    }

    const placeId = this.readByte(offset);
    const check = this.readByte(offset + 8 * ANALYSES_PER_SYMBOL);
    if (placeId > 0 && check === checksum(placeId)) {
      this.lastFrameAnalysis = analysis;
      this.onPlaceId(placeId);
    }
  }

  readByte(offset) {
    let byte = 0;
    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      const bit = this.history[(offset + bitIndex * ANALYSES_PER_SYMBOL) % this.history.length];
      if (bit === UNKNOWN_BIT) {
        return -1;
      }
      byte = (byte << 1) | bit;
    }
    return byte;
  }

  detectTone() {
    this.previous.fill(0);
    this.previousPrevious.fill(0);
    let cursor = this.sampleCursor;
    for (const weight of this.window) {
      const sample = this.samples[cursor] * weight;
      cursor += 1;
      if (cursor === this.samples.length) {
        cursor = 0;
      }
      for (let bin = 0; bin < this.coefficients.length; bin += 1) {
        const value = sample + this.coefficients[bin] * this.previous[bin] - this.previousPrevious[bin];
        this.previousPrevious[bin] = this.previous[bin];
        this.previous[bin] = value;
      }
    }

    for (let bin = 0; bin < this.coefficients.length; bin += 1) {
      const last = this.previous[bin];
      const before = this.previousPrevious[bin];
      this.powers[bin] = last * last + before * before - this.coefficients[bin] * last * before;
    }
    const bit = this.powers[0] >= this.powers[1] ? 0 : 1;
    const power = this.powers[bit];
    const oppositePower = this.powers[1 - bit];
    const firstNeighbor = 2 + 2 * bit;
    const neighborPower = Math.max(this.powers[firstNeighbor], this.powers[firstNeighbor + 1]);
    if (power >= this.minimumPower && power > 2 * oppositePower && power > 2.5 * neighborPower) {
      return bit;
    }
    return UNKNOWN_BIT;
  }
}
