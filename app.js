import { encodePlaceSignal, encodeWav, isSupportedSampleRate, PlaceSignalDecoder } from "./audio-modem.js";
import { createPlaceGate, getMapUrl, getPlace, PLACES, selectPlace } from "./places.js";

const byId = (id) => document.getElementById(id);
const receiverTab = byId("receiver-tab");
const studioTab = byId("studio-tab");
const receiverPanel = byId("receiver-panel");
const studioPanel = byId("studio-panel");
const listenButton = byId("listen-button");
const listenFeedback = byId("listen-feedback");
const placeCard = byId("place-card");
const speechButton = byId("speech-button");
const studioFeedback = byId("studio-feedback");
const cueFeedback = byId("cue-feedback");
const placeSelect = byId("place-select");
const AudioEngine = window.AudioContext ?? window.webkitAudioContext;
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
const WAV_SAMPLE_RATE = 48000;
const SPEECH_PAUSE_MS = 1050;
const receiveGate = createPlaceGate();
const sendGate = createPlaceGate();
const receivedTime = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });

let listening = null;
let speech = null;
let output = null;
let activeCue = null;

function feedback(element, message, isError = false) {
  element.textContent = message;
  element.hidden = !message;
  element.dataset.error = String(isError);
}

function status(id, state, message) {
  const element = byId(id);
  element.dataset.state = state;
  element.lastElementChild.textContent = message;
}

function showPlace(place, isDemo = false) {
  byId("received-name").textContent = place.name;
  byId("received-detail").textContent = place.region + (isDemo ? "" : " · " + receivedTime.format(new Date()));
  const tag = byId("result-tag");
  tag.textContent = isDemo ? "데모 수신" : "수신 완료";
  tag.hidden = false;

  const link = byId("map-link");
  link.href = getMapUrl(place);
  link.hidden = false;
  placeCard.dataset.hasPlace = "true";

  const result = byId("received-name").getBoundingClientRect();
  if (!isDemo && (result.top < 0 || result.bottom > window.innerHeight)) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    placeCard.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }
}

function receivePlace(id) {
  const place = getPlace(id);
  if (place && receiveGate.accept(place.id)) showPlace(place);
}

function setListeningStatus(state) {
  const text = {
    idle: ["수신 대기", "수신 시작"],
    pending: ["마이크 연결 중", "수신 취소"],
    active: ["수신 중", "수신 중지"],
    error: ["수신 중단", "다시 시도"],
  };
  const [label, buttonLabel] = text[state];
  status("receiver-status", state, label);
  byId("listen-button-text").textContent = buttonLabel;
  listenButton.closest(".receiver-surface").dataset.active = String(state === "active");
}

function stopListening(state = "idle", message = "") {
  const session = listening;
  listening = null;
  if (session?.worklet) {
    session.worklet.port.onmessage = null;
    session.worklet.port.close();
    session.worklet.disconnect();
  }
  session?.source?.disconnect();
  session?.stream?.getTracks().forEach((track) => track.stop());
  if (session && session.context.state !== "closed") {
    session.context.close().catch(() => {});
  }
  setListeningStatus(state);
  feedback(listenFeedback, message, state === "error");
}

function microphoneError(error) {
  switch (error.name) {
    case "NotAllowedError":
      return "브라우저의 사이트 설정에서 마이크를 허용한 뒤 다시 시도하세요.";
    case "NotFoundError":
      return "연결된 마이크가 없습니다. 기기의 마이크를 확인하세요.";
    case "NotReadableError":
      return "마이크를 열 수 없습니다. 마이크를 쓰는 다른 앱을 닫고 다시 시도하세요.";
    default:
      return "소리 수신기를 시작하지 못했습니다. 이 브라우저에서 데모는 실행할 수 있습니다.";
  }
}

async function startListening() {
  if (!window.isSecureContext) {
    stopListening("error", "마이크 수신은 HTTPS 또는 이 컴퓨터의 로컬 주소에서 가능합니다.");
    return;
  }
  if (!AudioEngine || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    stopListening("error", "이 브라우저에서는 마이크 수신을 지원하지 않습니다.");
    return;
  }

  let session;
  try {
    const context = new AudioEngine();
    session = { context };
    listening = session;
    setListeningStatus("pending");
    feedback(listenFeedback, "");
    if (!isSupportedSampleRate(context.sampleRate)) {
      stopListening("error", "현재 오디오 샘플링 속도는 고주파 수신을 지원하지 않습니다.");
      return;
    }
    const resumed = context.resume();
    resumed.catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (listening !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (listening === session) stopListening("error", "마이크 연결이 끊겼습니다. 다시 시작하세요.");
      });
    }
    await Promise.all([resumed, context.audioWorklet.addModule(new URL("./audio-input.js", import.meta.url))]);
    if (listening !== session) return;

    session.source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "place-input");
    session.worklet = worklet;
    worklet.port.onmessage = ({ data }) => {
      if (listening === session) receivePlace(data);
    };
    worklet.addEventListener("processorerror", () => {
      if (listening === session) stopListening("error", "소리 신호 처리가 중단됐습니다. 다시 시작하세요.");
    });
    session.source.connect(worklet).connect(context.destination);
    setListeningStatus("active");
  } catch (error) {
    if (listening === session || !session) stopListening("error", microphoneError(error));
  }
}

listenButton.addEventListener("click", () => {
  if (listening) stopListening();
  else void startListening();
});

byId("demo-button").addEventListener("click", () => {
  const place = selectPlace("오늘은 덕진공원에 가볼까요?");
  if (!place) return;
  const decoded = new PlaceSignalDecoder(WAV_SAMPLE_RATE, (id) => {
    const result = getPlace(id);
    if (result) showPlace(result, true);
  });
  const audio = encodePlaceSignal(place.id, { repeats: 1 });
  for (let offset = 0; offset < audio.length; offset += 128) {
    decoded.push(audio.subarray(offset, offset + 128));
  }
});

function startOutput() {
  if (!AudioEngine) throw new Error("이 브라우저에서는 소리 신호 재생을 지원하지 않습니다.");
  output ??= new AudioEngine();
  if (!isSupportedSampleRate(output.sampleRate)) throw new Error("현재 오디오 출력은 고주파 재생을 지원하지 않습니다.");
  return output.state === "running" ? Promise.resolve() : output.resume();
}

function stopCue() {
  if (activeCue) {
    activeCue.stop();
    activeCue = null;
  }
}

async function sendPlace(place, messageTarget, speechSession) {
  feedback(messageTarget, "");
  try {
    await startOutput();
    if (studioPanel.hidden || (speechSession && speech !== speechSession)) return;
    if (!sendGate.canAccept(place.id)) {
      feedback(messageTarget, "표시 간격을 적용했습니다. 새 장소는 15초, 같은 장소는 45초 뒤에 보낼 수 있습니다.");
      return;
    }

    const samples = encodePlaceSignal(place.id);
    const buffer = output.createBuffer(1, samples.length, WAV_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = output.createBufferSource();
    source.buffer = buffer;
    source.connect(output.destination);
    source.onended = () => {
      source.disconnect();
      if (activeCue === source) activeCue = null;
    };
    source.start();
    activeCue = source;
    sendGate.accept(place.id);
    feedback(messageTarget, "“" + place.name + "” 소리 신호를 보냈습니다.");
  } catch (error) {
    feedback(messageTarget, error.message || "소리 신호를 재생할 수 없습니다.", true);
  }
}

function sendTranscript(text, speechSession) {
  const place = selectPlace(text);
  if (!place) {
    feedback(studioFeedback, "보낼 장소를 고르지 못했습니다. 등록 장소 한 곳을 말해 주세요.");
    return;
  }
  placeSelect.value = String(place.id);
  void sendPlace(place, studioFeedback, speechSession);
}

byId("transcript-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendTranscript(byId("transcript").value);
});

function setSpeechStatus(state) {
  const text = {
    idle: ["음성 인식 꺼짐", "자동 음성 인식 시작"],
    pending: ["마이크 연결 중", "음성 인식 취소"],
    active: ["음성 인식 중", "음성 인식 중지"],
    error: ["음성 인식 중단", "다시 시도"],
  };
  const [label, buttonLabel] = text[state];
  status("speech-status", state, label);
  byId("speech-button-text").textContent = buttonLabel;
}

function stopSpeech(state = "idle", message = "") {
  const session = speech;
  speech = null;
  if (session) {
    clearTimeout(session.flushTimer);
    clearTimeout(session.restartTimer);
    session.recognition.abort();
  }
  setSpeechStatus(state);
  feedback(studioFeedback, message, state === "error");
}

function flushSpeech(session) {
  clearTimeout(session.flushTimer);
  if (speech !== session || !session.text) return;

  const display = byId("last-transcript");
  display.textContent = "마지막 인식 문장 · " + session.text;
  display.hidden = false;
  const text = session.text;
  session.text = "";
  sendTranscript(text, session);
}

function speechError(code) {
  const messages = {
    "not-allowed": "브라우저의 마이크 권한을 확인하세요. 아래에서 대사를 입력할 수도 있습니다.",
    "service-not-allowed": "이 브라우저에서 음성 인식 서비스를 사용할 수 없습니다. 아래에서 대사를 입력해 주세요.",
    "audio-capture": "음성 인식에 쓸 마이크를 찾지 못했습니다.",
    "network": "음성 인식 서비스에 연결하지 못했습니다. 아래에서 대사를 입력할 수도 있습니다.",
    "language-not-supported": "이 브라우저에서 한국어 음성 인식을 사용할 수 없습니다.",
  };
  return messages[code] ?? "음성 인식을 계속할 수 없습니다. 아래에서 대사를 입력할 수도 있습니다.";
}

function startSpeech() {
  if (!window.isSecureContext || !Recognition) {
    stopSpeech("error", "음성 인식은 Chrome 등 지원 브라우저의 HTTPS 페이지에서 사용할 수 있습니다. 아래에서 대사를 입력할 수도 있습니다.");
    return;
  }
  try {
    const playback = startOutput();
    const recognition = new Recognition();
    const session = { recognition, text: "" };
    speech = session;
    playback.catch(() => {
      if (speech === session) stopSpeech("error", "소리 신호 출력을 시작할 수 없습니다.");
    });
    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (speech === session) setSpeechStatus("active");
    };
    recognition.onspeechstart = () => clearTimeout(session.flushTimer);
    recognition.onresult = (event) => {
      if (speech !== session) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) session.text = (session.text + " " + result[0].transcript).trim().slice(-600);
      }
      clearTimeout(session.flushTimer);
      if (session.text) session.flushTimer = setTimeout(() => flushSpeech(session), SPEECH_PAUSE_MS);
    };
    recognition.onerror = ({ error }) => {
      if (speech === session && error !== "no-speech") stopSpeech("error", speechError(error));
    };
    recognition.onend = () => {
      if (speech !== session) return;
      flushSpeech(session);
      session.restartTimer = setTimeout(() => {
        if (speech !== session) return;
        try {
          recognition.start();
        } catch {
          stopSpeech("error", "음성 인식을 다시 시작해 주세요.");
        }
      }, 350);
    };
    setSpeechStatus("pending");
    feedback(studioFeedback, "");
    recognition.start();
  } catch (error) {
    stopSpeech("error", error.message || "음성 인식을 시작할 수 없습니다.");
  }
}

speechButton.addEventListener("click", () => {
  if (speech) stopSpeech();
  else startSpeech();
});

for (const place of PLACES) {
  placeSelect.add(new Option(place.name + " · " + place.region, String(place.id)));
}

byId("play-cue").addEventListener("click", () => {
  void sendPlace(getPlace(Number(placeSelect.value)), cueFeedback);
});

byId("download-cue").addEventListener("click", () => {
  const place = getPlace(Number(placeSelect.value));
  const wav = encodeWav(encodePlaceSignal(place.id), WAV_SAMPLE_RATE);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = place.name + "-48k.wav";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  feedback(cueFeedback, "“" + place.name + "” 신호를 48 kHz WAV로 내보냈습니다.");
});

function setMode(studio, updateUrl) {
  if (studio) stopListening();
  else {
    stopSpeech();
    stopCue();
  }
  receiverPanel.hidden = studio;
  studioPanel.hidden = !studio;
  receiverTab.setAttribute("aria-selected", String(!studio));
  studioTab.setAttribute("aria-selected", String(studio));
  receiverTab.tabIndex = studio ? -1 : 0;
  studioTab.tabIndex = studio ? 0 : -1;
  if (updateUrl) {
    const url = new URL(window.location.href);
    if (studio) url.searchParams.set("mode", "studio");
    else url.searchParams.delete("mode");
    window.history.replaceState(null, "", url);
  }
}

for (const tab of [receiverTab, studioTab]) {
  tab.addEventListener("click", () => {
    if (tab.getAttribute("aria-selected") === "false") setMode(tab === studioTab, true);
  });
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const chooseStudio = event.key === "End" || (event.key !== "Home" && tab === receiverTab);
    setMode(chooseStudio, true);
    (chooseStudio ? studioTab : receiverTab).focus();
  });
}

byId("open-guide").addEventListener("click", () => byId("guide").showModal());
window.addEventListener("pagehide", () => {
  stopListening();
  stopSpeech();
  stopCue();
  if (output?.state === "running") output.suspend().catch(() => {});
});
setMode(new URLSearchParams(window.location.search).get("mode") === "studio", false);

function drawMap() {
  const canvas = byId("map-art");
  const context = canvas.getContext("2d");
  if (!context) return;

  const { width, height } = canvas;
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#17182d");
  background.addColorStop(0.56, "#25203b");
  background.addColorStop(1, "#14182b");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const glow = context.createRadialGradient(382, 154, 12, 382, 154, 265);
  glow.addColorStop(0, "#7954b05c");
  glow.addColorStop(1, "#7954b000");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  context.fillStyle = "#bda7f931";
  for (let x = 12; x < width; x += 24) {
    for (let y = 12; y < height; y += 24) context.fillRect(x, y, 1.5, 1.5);
  }
  context.strokeStyle = "#a38ce257";
  context.lineWidth = 1.15;
  for (let level = 0; level < 17; level += 1) {
    const radius = 31 + level * 16;
    context.beginPath();
    for (let step = 0; step <= 120; step += 1) {
      const angle = step / 120 * Math.PI * 2;
      const curve = Math.sin(angle * 3 + level * 0.11) * (9 + level * 1.1) + Math.cos(angle * 5) * 5;
      const x = 382 + Math.cos(angle) * (radius + curve) * 1.65;
      const y = 154 + Math.sin(angle) * (radius + curve) * 0.86 + Math.cos(angle) * radius * 0.25;
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.stroke();
  }
}

drawMap();
