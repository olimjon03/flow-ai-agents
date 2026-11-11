const form = document.querySelector('#brief-form');
const brief = document.querySelector('#brief');
const draft = document.querySelector('#draft');
const emptyState = document.querySelector('#empty');
const copyButton = document.querySelector('#copy');
const status = document.querySelector('#status');
const generateButton = form.querySelector('button[type=submit]');

brief.addEventListener('input', () => brief.setCustomValidity(''));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (generateButton.disabled) return;

  const text = brief.value.trim();
  if (!text) {
    brief.setCustomValidity('Brif matnini yozing.');
    brief.reportValidity();
    return;
  }

  const format = new FormData(form).get('format');
  generateButton.disabled = true;
  generateButton.textContent = 'Tayyorlanmoqda…';
  draft.readOnly = true;
  copyButton.disabled = true;
  status.textContent = 'Qoralama tayyorlanmoqda…';

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: text, format }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Generation request failed');

    const result = await response.json();
    if (typeof result.draft !== 'string' || !result.draft.trim()) {
      throw new Error('Invalid draft');
    }

    draft.value = result.draft;
    emptyState.hidden = true;
    draft.hidden = false;
    status.textContent = 'Qoralama tayyor.';
    draft.focus();
    draft.setSelectionRange(0, 0);
  } catch {
    status.textContent = 'Qoralama yaratilmadi. Qayta urinib ko‘ring.';
  } finally {
    generateButton.disabled = false;
    generateButton.textContent = 'Qoralama yaratish';
    draft.readOnly = false;
    copyButton.disabled = !draft.value.trim();
  }
});

draft.addEventListener('input', () => {
  copyButton.disabled = !draft.value.trim();
  status.textContent = '';
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(draft.value);
    status.textContent = 'Qoralama nusxalandi.';
  } catch {
    draft.focus();
    draft.select();
    status.textContent = 'Matn belgilandi. Nusxalash uchun Ctrl+C yoki ⌘C tugmalarini bosing.';
  }
});
