(() => {
  'use strict';
  const root = document.getElementById('lucky-visualizations');
  if (!root || !window.LuckyVisualizationScenes) return;
  const copy = {
    en: {
      kicker: 'NEW · SUCCESS VISUALIZATION', title: 'See yourself respond with confidence.',
      intro: 'Original AI-written audio rehearsals in three short scenes. Start with interview confidence, or practice recovery, boundaries, and mutual connection.',
      language: 'Audio & script language', choose: 'Choose this practice →', selected: 'Selected practice',
      play: 'Listen with AI voice', stop: 'Stop', speed: 'Speed', transcript: 'Read the three scenes',
      help: 'AI-written scenes, narrated with an AI voice. Use the audio controls to pause or seek. If a recording cannot load, you can retry with a newly generated narration.',
      ready: 'Ready to listen.', loading: 'Creating your guided audio…', available: 'Audio ready. Press play in the audio controls.',
      playing: 'Playing AI narration.', paused: 'Paused. Resume with the audio controls.', ended: 'Practice complete. Take one small step.',
      stopped: 'Stopped. You can listen again when you are ready.', error: 'AI narration is unavailable right now. Try again, read the script, or use your device voice.',
      device: 'Read with device voice', devicePause: 'Pause device voice', deviceResume: 'Resume device voice', devicePlaying: 'Reading with your device voice.',
      deviceError: 'Device voice could not play. You can read the full script below.',
      action: 'After listening', general: 'Listen somewhere safe, never while driving. You can keep your eyes open or stop whenever you like.'
    }
  };
  const language = 'en';
  let selectedId = 'interview';
  let token = 0;
  let controller = null;
  let objectUrl = null;
  let deviceMode = false;
  let devicePaused = false;
  let needsGeneration = false;
  const memoryCache = new Map();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(className, text) {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }
  function current() { return window.LuckyVisualizationScenes.find(scene => scene.id === selectedId)[language]; }
  function narration(scene) { return [scene.opening, ...scene.scenes.map(part => part[1]), scene.closing].join('\n\n'); }
  function stop() {
    token++;
    controller?.abort();
    controller = null;
    if (deviceMode) window.speechSynthesis?.cancel();
    deviceMode = devicePaused = false;
    if (audio) { audio.pause(); if (audio.readyState) audio.currentTime = 0; }
    if (playButton) {
      playButton.disabled = false;
      status.textContent = copy[language].stopped;
      deviceButton.textContent = copy[language].device;
    }
    if (typeof setAmbientDucked === 'function') setAmbientDucked(false);
  }
  function disposeAudio() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (audio) { audio.removeAttribute('src'); audio.load(); audio.hidden = true; }
  }
  // Existing exercise navigation calls this before leaving the list.
  window.stopLuckyVisualization = stop;
  window.addEventListener('pagehide', () => { stop(); disposeAudio(); });

  let audio, playButton, stopButton, deviceButton, speedSelect, status, playerTitle, transcript, actionText, note;
  const heading = element('div', 'lv-heading');
  const headingCopy = element('div');
  const kicker = element('div', 'lv-kicker');
  const title = element('h2'); title.id = 'lv-title';
  const intro = element('p');
  headingCopy.append(kicker, title, intro);
  heading.append(headingCopy);
  const grid = element('div', 'lv-grid');
  const player = element('div', 'lv-player');
  playerTitle = element('h3'); playerTitle.id = 'lv-player-title';
  player.setAttribute('aria-labelledby', playerTitle.id);
  const toolbar = element('div', 'lv-toolbar');
  playButton = button('lv-primary');
  stopButton = button('');
  const speedLabel = element('label', 'lv-language');
  const speedText = element('span');
  speedSelect = element('select');
  for (const value of ['0.8', '1', '1.2']) {
    const option = element('option', '', `${value}×`); option.value = value; speedSelect.append(option);
  }
  speedSelect.value = '1'; speedLabel.append(speedText, speedSelect);
  toolbar.append(playButton, stopButton, speedLabel);
  status = element('p', 'lv-status'); status.setAttribute('role', 'status');
  const help = element('p', 'lv-help');
  audio = element('audio', 'lv-audio'); audio.controls = true; audio.preload = 'metadata'; audio.hidden = true;
  deviceButton = button(''); deviceButton.hidden = true;
  transcript = element('details', 'lv-transcript');
  const action = element('div', 'lv-action');
  const actionLabel = element('h4'); actionText = element('p'); action.append(actionLabel, actionText);
  note = element('p', 'lv-note');
  const general = element('p', 'lv-note');
  player.append(playerTitle, toolbar, status, help, audio, deviceButton, transcript, action, note, general);
  root.append(heading, grid, player);

  function render() {
    needsGeneration = false;
    const words = copy[language];
    root.lang = 'en';
    kicker.textContent = words.kicker; title.textContent = words.title; intro.textContent = words.intro;
    playButton.textContent = words.play;
    stopButton.textContent = words.stop; speedText.textContent = words.speed; help.textContent = words.help;
    deviceButton.textContent = words.device; deviceButton.hidden = true; general.textContent = words.general;
    grid.replaceChildren();
    for (const entry of window.LuckyVisualizationScenes) {
      const scene = entry[language];
      const card = element('article', `lv-card${entry.id === selectedId ? ' is-selected' : ''}`);
      const select = button('', entry.id === selectedId ? words.selected : words.choose);
      select.setAttribute('aria-pressed', String(entry.id === selectedId));
      select.setAttribute('aria-label', `${words.choose} ${scene.title}`);
      select.addEventListener('click', () => {
        stop(); disposeAudio(); selectedId = entry.id; render();
        player.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      card.append(element('span', 'lv-tag', scene.tag), element('h3', '', scene.title), element('p', '', scene.description), select);
      grid.append(card);
    }
    const scene = current();
    playerTitle.textContent = scene.title; status.textContent = words.ready; actionLabel.textContent = words.action;
    actionText.textContent = scene.action; note.textContent = scene.note;
    transcript.replaceChildren(element('summary', '', words.transcript), element('p', '', scene.opening));
    scene.scenes.forEach((part, index) => transcript.append(element('h4', '', `${index + 1}. ${part[0]}`), element('p', '', part[1])));
    transcript.append(element('p', '', scene.closing));
  }
  speedSelect.addEventListener('change', () => { audio.playbackRate = Number(speedSelect.value); });
  stopButton.addEventListener('click', stop);
  audio.addEventListener('play', () => {
    if (deviceMode) { window.speechSynthesis?.cancel(); deviceMode = devicePaused = false; deviceButton.textContent = copy[language].device; }
    if (typeof stopVoice === 'function') stopVoice();
    if (typeof setAmbientDucked === 'function') setAmbientDucked(true);
    status.textContent = copy[language].playing;
  });
  audio.addEventListener('pause', () => {
    if (audio.src && !audio.ended) status.textContent = copy[language].paused;
    if (typeof setAmbientDucked === 'function') setAmbientDucked(false);
  });
  audio.addEventListener('ended', () => {
    status.textContent = copy[language].ended;
    if (typeof setAmbientDucked === 'function') setAmbientDucked(false);
  });
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    status.textContent = copy[language].error;
    needsGeneration = true;
    deviceButton.hidden = !('speechSynthesis' in window);
    if (typeof setAmbientDucked === 'function') setAmbientDucked(false);
  });
  playButton.addEventListener('click', async () => {
    stop();
    if (typeof stopVoice === 'function') stopVoice();
    const run = token;
    const words = copy[language];
    if (!needsGeneration) {
      if (!audio.getAttribute('src')) audio.src = `/audio/visualizations/${selectedId}-${language}-v1.mp3`;
      audio.hidden = false; audio.playbackRate = Number(speedSelect.value);
      status.textContent = words.available;
      try { await audio.play(); } catch (error) {
        if (run !== token) return;
        if (error.name === 'NotSupportedError') {
          needsGeneration = true; status.textContent = words.error;
          deviceButton.hidden = !('speechSynthesis' in window);
        } else status.textContent = words.available;
      }
      return;
    }
    const text = narration(current());
    const key = `lucky-visualization-v1:${language}:${text}`;
    playButton.disabled = true; deviceButton.hidden = true; status.textContent = words.loading;
    const requestController = new AbortController();
    controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 90000);
    try {
      let buffer = memoryCache.get(key);
      if (!buffer && typeof getCachedAudio === 'function') buffer = await getCachedAudio(key);
      if (run !== token) return;
      if (!buffer) {
        const response = await fetch('/api/speak', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, language }), signal: requestController.signal
        });
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('audio/')) throw new Error('Narration unavailable');
        buffer = await response.arrayBuffer();
        if (buffer.byteLength < 44) throw new Error('Empty audio');
        if (run !== token) return;
        if (typeof setCachedAudio === 'function') void setCachedAudio(key, buffer);
      }
      if (run !== token) return;
      memoryCache.set(key, buffer);
      disposeAudio();
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
      audio.src = objectUrl; audio.hidden = false; audio.playbackRate = Number(speedSelect.value);
      status.textContent = words.available;
      // Mobile browsers may require a second tap after asynchronous generation.
      try { await audio.play(); } catch { if (run === token) status.textContent = words.available; }
    } catch {
      if (run === token) {
        status.textContent = words.error;
        deviceButton.hidden = !('speechSynthesis' in window);
      }
    } finally {
      clearTimeout(timeout);
      if (run === token) { controller = null; playButton.disabled = false; }
    }
  });
  deviceButton.addEventListener('click', () => {
    if (deviceMode) {
      devicePaused = !devicePaused;
      if (devicePaused) window.speechSynthesis.pause(); else window.speechSynthesis.resume();
      deviceButton.textContent = copy[language][devicePaused ? 'deviceResume' : 'devicePause'];
      status.textContent = copy[language][devicePaused ? 'paused' : 'devicePlaying'];
      return;
    }
    stop();
    if (typeof stopVoice === 'function') stopVoice();
    const run = token;
    const parts = narration(current()).split('\n\n');
    let index = 0;
    deviceMode = true;
    deviceButton.textContent = copy[language].devicePause;
    status.textContent = copy[language].devicePlaying;
    function next() {
      if (run !== token || !deviceMode) return;
      if (index === parts.length) {
        deviceMode = false; deviceButton.textContent = copy[language].device;
        status.textContent = copy[language].ended; return;
      }
      const utterance = new SpeechSynthesisUtterance(parts[index++]);
      utterance.lang = 'en-US';
      utterance.rate = .9 * Number(speedSelect.value);
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find(item => item.lang.startsWith(language));
      if (voice) utterance.voice = voice;
      utterance.onend = next;
      utterance.onerror = () => {
        if (run !== token) return;
        deviceMode = false; deviceButton.textContent = copy[language].device;
        status.textContent = copy[language].deviceError;
      };
      window.speechSynthesis.speak(utterance);
    }
    next();
  });
  render();
})();
