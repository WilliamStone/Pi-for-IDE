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
  let lastProbe = '';   // 最近一次 serverReady 的探测地址——offline 兜底页回报后按它重探
  let offlineShown = false; // iframe 停在 SW offline 兜底页——load/display 判就绪都要排除它
  let offlineRetry = 0; // 兜底→重探→再兜底自愈链的连续重试计数，防服务真死时空转

  vscode.postMessage({ source: 'piIde.log', text: 'shell painted' });

  function setStatus(text) {
    if (gate.classList.contains('error')) return;
    gateText.innerHTML = String(text) + dots;
  }

  function showFrame(url) {
    if (loadedUrl === url && frame.style.display === 'block' && !offlineShown) return;
    vscode.postMessage({ source: 'piIde.log', text: 'server probe passed, setting iframe.src' });
    loadedUrl = url;
    offlineShown = false; // 本次导航重新定性——旧兜底态若带到新文档 load，门永不收
    gateText.innerHTML = 'Connecting to local server' + dots;
    gate.style.display = 'grid';
    frame.src = url;
  }
  frame.addEventListener('load', function () {
    // offline.html 也触发 load——它的回报消息先于 load 到达（解析期
    // postMessage 排在该文档 load 任务前），据此不收门、不消重试计数。
    if (offlineShown) return;
    vscode.postMessage({ source: 'piIde.log', text: 'iframe page loaded' });
    offlineRetry = 0;
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
      } catch {
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
      // 已就绪才忽略——offline 兜底页 display:block 不算就绪，照常重探。
      if (loadedUrl === p.url && frame.style.display === 'block' && !offlineShown) return;
      lastProbe = p.probe;
      setStatus('Connecting to local server');
      probeAndShow(p.url, p.probe, ++gen);
    } else if (data.source === 'pi-web-offline') {
      // iframe 导航落到 SW 兜底页（取文档失败/超时）——回到探测等待，
      // 服务恢复即自动重导航；连兜底 3 次说明非瞬断，转错误门给出路。
      offlineShown = true;
      frame.style.display = 'none';
      gate.style.display = 'grid';
      vscode.postMessage({ source: 'piIde.log', text: 'iframe landed on offline fallback, re-probing' });
      if (offlineRetry++ < 3 && loadedUrl && lastProbe) {
        setStatus('Reconnecting to local server');
        probeAndShow(loadedUrl, lastProbe, ++gen);
      } else {
        gen++;
        gate.classList.add('error');
        gateText.innerHTML =
          'Cannot reach the Pi for IDE server.<br/>' +
          'Check the output panel (View → Output → Pi for IDE), or run "Pi for IDE: Stop Server" and retry.';
      }
    } else if (data.source === 'host' && p.kind === 'serverError') {
      gen++;
      gate.classList.add('error');
      gate.style.display = 'grid';
      gateText.innerHTML = String(p.text);
    } else if (data.source === 'embed') {
      // iframe -> extension host. Forward the whole envelope (id + request).
      if (data.request && data.request.kind === 'keyPassthrough') {
        // 页面没消费的组合键：在 shell 文档上合成等量 keydown/keyup——
        // VS Code 注入 webview 的 main.js 监听这一层，会把它当普通按键
        // 转给 workbench 快捷键系统做原生解析（用户自定义绑定与 when
        // 子句全生效），不再经 extension host 中映射表。
        var init = {
          key: data.request.key,
          code: data.request.code,
          keyCode: data.request.keyCode,
          ctrlKey: !!data.request.ctrlKey,
          altKey: !!data.request.altKey,
          shiftKey: !!data.request.shiftKey,
          metaKey: !!data.request.metaKey,
          repeat: !!data.request.repeat,
          bubbles: true,
          cancelable: true,
        };
        var target = document.body || document;
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
        return;
      }
      vscode.postMessage(data);
    } else if (data.source === 'host') {
      // extension host -> iframe. Forward responses and notifications.
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(data, '*');
      }
    }
  });
})();
