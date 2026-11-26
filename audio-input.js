import { PlaceSignalDecoder } from "./audio-modem.js";

class PlaceInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.decoder = new PlaceSignalDecoder(sampleRate, (id) => this.port.postMessage(id));
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.decoder.push(channel);
    return true;
  }
}

registerProcessor("place-input", PlaceInputProcessor);
