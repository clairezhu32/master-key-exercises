(() => {
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) document.documentElement.classList.add('pwa-standalone');

  let installPrompt;
  const showInstallButton = () => {
    if (standalone || document.getElementById('lucky-install')) return;
    const button = document.createElement('button');
    button.id = 'lucky-install';
    button.type = 'button';
    button.textContent = 'Install Lucky';
    Object.assign(button.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '9999', minHeight: '44px', padding: '0 17px',
      border: '1px solid #d7ff58', borderRadius: '8px', color: '#11110f', background: '#d7ff58',
      font: '700 13px system-ui, sans-serif', boxShadow: '0 10px 30px rgba(0,0,0,.35)', cursor: 'pointer'
    });
    button.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      button.remove();
    });
    document.body.appendChild(button);
  };

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    showInstallButton();
  });
  window.addEventListener('appinstalled', () => document.getElementById('lucky-install')?.remove());

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos && !standalone && !sessionStorage.getItem('lucky-ios-install-tip')) {
    window.addEventListener('load', () => {
      const tip = document.createElement('div');
      tip.setAttribute('role', 'status');
      tip.textContent = 'Install Lucky: tap Share, then “Add to Home Screen”.';
      Object.assign(tip.style, {
        position: 'fixed', left: '12px', right: '12px', bottom: '12px', zIndex: '9999', padding: '13px 42px 13px 14px',
        border: '1px solid #414139', borderRadius: '8px', color: '#f4f3ec', background: '#20201b',
        font: '600 12px/1.4 system-ui, sans-serif', boxShadow: '0 10px 30px rgba(0,0,0,.4)'
      });
      const close = document.createElement('button');
      close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss install tip');
      Object.assign(close.style, { position: 'absolute', right: '8px', top: '5px', border: '0', color: '#f4f3ec', background: 'transparent', fontSize: '22px' });
      close.addEventListener('click', () => { sessionStorage.setItem('lucky-ios-install-tip', '1'); tip.remove(); });
      tip.appendChild(close); document.body.appendChild(tip);
    });
  }
})();
