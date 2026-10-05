(() => {
  const ua = navigator.userAgent || '';
  const isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const isChromeIos = /crios/i.test(ua);
  const isFirefoxIos = /fxios/i.test(ua);
  const isEdgeIos = /edgios/i.test(ua);
  const isSafariIos = isIos && /safari/i.test(ua) && !isChromeIos && !isFirefoxIos && !isEdgeIos;
  const isInAppBrowser = isIos && /FBAN|FBAV|Instagram|Line\/|MicroMessenger|GSA\/|ChatGPT|LinkedInApp|Twitter|TikTok/i.test(ua);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  window.__luckyPwaDebug = {
    isIos,
    isAndroid,
    isChromeIos,
    isSafariIos,
    isInAppBrowser,
    standalone
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        await registration.update();
      } catch {}
    });
  }

  if (standalone) {
    document.documentElement.classList.add('pwa-standalone');
    return;
  }

  let installPrompt;

  const applyStyles = (element, styles) => Object.assign(element.style, styles);

  const createButton = (label, onClick, secondary = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    applyStyles(button, {
      minHeight: '46px',
      padding: '0 16px',
      border: secondary ? '1px solid #56564d' : '1px solid #d7ff58',
      borderRadius: '8px',
      color: secondary ? '#f4f3ec' : '#11110f',
      background: secondary ? '#171714' : '#d7ff58',
      font: '700 13px system-ui, sans-serif',
      cursor: 'pointer'
    });
    button.addEventListener('click', onClick);
    return button;
  };

  const browserInstructions = () => {
    if (isInAppBrowser) {
      return {
        title: 'Open Lucky in Safari first',
        steps: [
          'Tap the browser menu (usually ···) and choose “Open in Safari”.',
          'In Safari, tap the Page Menu or Share icon beside the address bar.',
          'Choose “Add to Home Screen”, then tap “Add”.'
        ],
        note: 'In-app browsers such as ChatGPT, Instagram, LinkedIn and WeChat cannot install Lucky directly.'
      };
    }
    if (isChromeIos) {
      return {
        title: 'Add Lucky from Chrome',
        steps: [
          'Tap the Share icon beside the address bar. If it is hidden, tap ··· first.',
          'Scroll down and choose “Add to Home Screen”.',
          'Confirm the name Lucky, then tap “Add”.'
        ],
        note: 'If “Add to Home Screen” is missing, copy this link and open it in Safari.'
      };
    }
    if (isSafariIos) {
      return {
        title: 'Add Lucky from Safari',
        steps: [
          'Tap the Page Menu or Share icon beside the address bar.',
          'Choose “Add to Home Screen”. You may need to scroll or tap “More”.',
          'Keep “Open as Web App” on if shown, then tap “Add”.'
        ],
        note: 'The Lucky icon will appear on your Home Screen and open like an app.'
      };
    }
    return {
      title: 'Install Lucky',
      steps: [
        'Open your browser menu.',
        'Choose “Install app” or “Add to Home screen”.',
        'Confirm to add Lucky to your device.'
      ],
      note: 'If the install option is missing, open this page in Safari on iPhone or Chrome on Android.'
    };
  };

  const copyCurrentLink = async button => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const original = button.textContent;
      button.textContent = 'Link copied';
      window.setTimeout(() => { button.textContent = original; }, 1800);
    } catch {
      window.prompt('Copy this link, then open it in Safari:', window.location.href);
    }
  };

  const showInstallHelp = () => {
    document.getElementById('lucky-install-help')?.remove();
    const info = browserInstructions();
    const overlay = document.createElement('div');
    overlay.id = 'lucky-install-help';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'lucky-install-title');
    applyStyles(overlay, {
      position: 'fixed', inset: '0', zIndex: '10001', display: 'flex', alignItems: 'flex-end',
      justifyContent: 'center', padding: '16px', background: 'rgba(0,0,0,.66)'
    });

    const sheet = document.createElement('div');
    applyStyles(sheet, {
      position: 'relative', width: 'min(520px, 100%)', padding: '24px', border: '1px solid #56564d',
      borderRadius: '16px 16px 10px 10px', color: '#f4f3ec', background: '#20201b',
      boxShadow: '0 22px 70px rgba(0,0,0,.55)', font: '14px/1.55 system-ui, sans-serif'
    });

    const eyebrow = document.createElement('div');
    eyebrow.textContent = 'LUCKY ON YOUR PHONE';
    applyStyles(eyebrow, { marginBottom: '8px', color: '#d7ff58', fontSize: '11px', fontWeight: '800', letterSpacing: '.09em' });

    const title = document.createElement('h2');
    title.id = 'lucky-install-title';
    title.textContent = info.title;
    applyStyles(title, { margin: '0 34px 14px 0', color: '#f4f3ec', font: '700 23px/1.2 system-ui, sans-serif' });

    const list = document.createElement('ol');
    applyStyles(list, { margin: '0 0 14px', paddingLeft: '21px', color: '#f4f3ec' });
    info.steps.forEach(step => {
      const item = document.createElement('li');
      item.textContent = step;
      applyStyles(item, { marginBottom: '9px', paddingLeft: '4px' });
      list.appendChild(item);
    });

    const note = document.createElement('p');
    note.textContent = info.note;
    applyStyles(note, { margin: '0 0 18px', color: '#aaa99e', fontSize: '12px' });

    const actions = document.createElement('div');
    applyStyles(actions, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' });
    const copy = createButton('Copy Lucky link', event => copyCurrentLink(event.currentTarget));
    const done = createButton('Close', () => overlay.remove(), true);
    actions.append(copy, done);

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close install instructions');
    applyStyles(close, {
      position: 'absolute', right: '14px', top: '12px', width: '38px', height: '38px', border: '0',
      color: '#f4f3ec', background: 'transparent', fontSize: '27px', cursor: 'pointer'
    });
    close.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function handleEscape(event) {
      if (event.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handleEscape); }
    });

    sheet.append(eyebrow, title, list, note, actions, close);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  };

  const showInstallButton = () => {
    if (document.getElementById('lucky-install')) return;
    const button = document.createElement('button');
    button.id = 'lucky-install';
    button.type = 'button';
    button.textContent = isIos ? 'Add Lucky to Home Screen' : 'Install Lucky';
    button.setAttribute('aria-label', button.textContent);
    applyStyles(button, {
      position: 'fixed', right: '14px', bottom: '14px', zIndex: '9999', minHeight: '46px', padding: '0 17px',
      border: '1px solid #d7ff58', borderRadius: '8px', color: '#11110f', background: '#d7ff58',
      font: '700 13px system-ui, sans-serif', boxShadow: '0 10px 30px rgba(0,0,0,.4)', cursor: 'pointer'
    });
    button.addEventListener('click', async () => {
      if (installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        button.remove();
        return;
      }
      showInstallHelp();
    });
    document.body.appendChild(button);
  };

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    showInstallButton();
  });

  window.addEventListener('appinstalled', () => document.getElementById('lucky-install')?.remove());

  window.addEventListener('load', () => {
    if (isIos || isAndroid) showInstallButton();
  });
})();
