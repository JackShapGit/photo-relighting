export async function prepare(file, mode) {
  const fd = new FormData();
  fd.append('image', file);
  fd.append('mode', mode);
  const r = await fetch('/prepare', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`/prepare: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function render(body) {
  const r = await fetch('/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/render: ${r.status}`);
  return r.blob();
}

export async function listGobos() {
  const r = await fetch('/gobos');
  if (!r.ok) throw new Error(`/gobos: ${r.status}`);
  return r.json();
}
