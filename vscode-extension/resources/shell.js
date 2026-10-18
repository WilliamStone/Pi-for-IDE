// Pi for IDE webview shell — relays messages between the pi-web iframe and the
// VSCode extension host. Loaded as a static webview resource (CSP: script-src
// allows only vscode-resource: URIs).
(function () {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('pi-web-frame');
  const gate = document.getElementById('gate');
  const gateText = document.getElementById('gate-text');
  const dots = '<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
  let gen = 0;          // serverReady 代际：新一轮探测作废旧轮询
  let loadedUrl = '';   // iframe 已加载的地址

  vscode.postMessage({ source: 'piIde.log', text: 'shell painted' });

  function setStatus(text) {
    if (gate.classList.contains('error')) return;
    gateText.innerHTML = String(text) + dots;
  }

  function showFrame(url) {
    if (loadedUrl === url && frame.style.display === 'block') return;
    vscode.postMessage({ source: 'piIde.log', text: 'server probe passed, setting iframe.src' });
    loadedUrl = url;
    gateText.innerHTML = 'Connecting to local server' + dots;
    gate.style.display = 'grid';
    frame.src = url;
  }
  frame.addEventListener('load', function () {
    vscode.postMessage({ source: 'piIde.log', text: 'iframe page loaded' });
    gate.style.display = 'none';
    frame.style.display = 'block';
  });

  async function probeAndShow(url, probe, myGen) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && gen === myGen) {
      try {
        await fetch(probe, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
        if (gen !== myGen) return;
        showFrame(url);
        return;
      } catch (e) {
        await new Promise(function (r) { setTimeout(r, 1500); });
      }
    }
    if (gen !== myGen) return;
    gate.classList.add('error');
    vscode.postMessage({ source: 'piIde.log', text: '90s probe timeout, showing failure page' });
    gateText.innerHTML =
      'Cannot reach the Pi for IDE server.<br/>' +
      'Check the output panel (View → Output → Pi for IDE), or run "Pi for IDE: Stop Server" and retry.';
  }

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const p = data.payload || {};
    if (data.source === 'host' && p.kind === 'status') {
      setStatus(p.text);
    } else if (data.source === 'host' && p.kind === 'serverReady') {
      gate.classList.remove('error');
      if (loadedUrl === p.url && frame.style.display === 'block') return; // 已就绪，忽略
      setStatus('Connecting to local server');
      probeAndShow(p.url, p.probe, ++gen);
    } else if (data.source === 'host' && p.kind === 'serverError') {
      gen++;
      gate.classList.add('error');
      gate.style.display = 'grid';
      gateText.innerHTML = String(p.text);
    } else if (data.source === 'embed') {
      // iframe -> extension host. Forward the whole envelope (id + request).
      vscode.postMessage(data);
    } else if (data.source === 'host') {
      // extension host -> iframe. Forward responses and notifications.
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(data, '*');
      }
    }
  });
})();
