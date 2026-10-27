// Reproduce the "reload → chrome but empty content" bug without VSCodium:
// hammer the real /api/sessions/<id> mount-path requests against a fresh
// server with the user's real session files. Mirrors loadSession's mount
// sequence (force=1 detail + state + events SSE kick + list).
const BASE = process.env.HAMMER_BASE ?? "http://127.0.0.1:39990";
const SID = process.env.HAMMER_SID ?? "01a1693b-53ba-7669-829b-bcbce41012ce";
const ROUNDS = Number(process.env.HAMMER_ROUNDS ?? 30);

async function sseKick() {
  // Fire-and-close the events stream — mirrors maintain() arming the wrapper.
  const ctrl = new AbortController();
  try {
    const res = await fetch(`${BASE}/api/agent/${SID}/events`, { signal: ctrl.signal });
    // Read one chunk then abort — enough for the server to create the wrapper.
    const reader = res.body?.getReader();
    if (reader) { await Promise.race([reader.read(), new Promise(r => setTimeout(r, 300))]); reader.cancel().catch(() => {}); }
    return res.status;
  } catch { return "aborted"; }
  finally { ctrl.abort(); }
}

async function once(round) {
  const detailUrl = `${BASE}/api/sessions/${SID}?deferThinking=1&deferMedia=1&tree=summary&force=1`;
  const [detail, state, ev, list] = await Promise.all([
    fetch(detailUrl).then(async r => ({ status: r.status, body: r.status === 200 ? await r.json() : await r.text() }))
      .catch(e => ({ status: "ERR", body: String(e) })),
    fetch(`${BASE}/api/sessions/${SID}/state`).then(r => r.status).catch(e => String(e)),
    sseKick(),
    fetch(`${BASE}/api/sessions?summary=1`).then(r => r.status).catch(e => String(e)),
  ]);
  const msgs = typeof detail.body === "object" && detail.body !== null
    ? detail.body.context?.messages?.length ?? -1
    : -1;
  const entries = typeof detail.body === "object" && detail.body !== null
    ? detail.body.context?.entryIds?.length ?? -1
    : -1;
  const tag = detail.status !== 200 ? `!!! status=${detail.status}` : msgs === 0 ? `!!! EMPTY msgs=0 entries=${entries}` : `ok msgs=${msgs} entries=${entries}`;
  console.log(`round ${round}: ${tag} | state=${state} events=${ev} list=${list}`);
  return detail.status !== 200 || msgs === 0 ? 1 : 0;
}

let failures = 0;
for (let i = 1; i <= ROUNDS; i++) {
  failures += await once(i);
}
console.log(`DONE: ${failures}/${ROUNDS} degenerate responses`);
process.exit(failures ? 1 : 0);
