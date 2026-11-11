const form = document.querySelector('#brief-form');
const brief = document.querySelector('#brief');
const draft = document.querySelector('#draft');
const emptyState = document.querySelector('#empty');
const copyButton = document.querySelector('#copy');
const status = document.querySelector('#status');

const draftTemplates = {
  post: (text) => [
    'E’tiborni tortadigan sarlavha yozing.',
    text,
    'Mavzuni bitta aniq misol bilan ochib bering.',
    'Yakunida o‘quvchiga savol bering yoki keyingi qadamni taklif qiling.',
  ].join('\n\n'),
  video: (text) => [
    '0–3 soniya · Kirish\nTomoshabin e’tiborini tortadigan savol yoki jumla ayting.',
    `3–20 soniya · Asosiy qism\n${text}\nAsosiy fikrni bitta misol yoki kadr bilan ko‘rsating.`,
    '20–30 soniya · Yakun\nBitta xulosa ayting va tomoshabinga keyingi qadamni taklif qiling.',
  ].join('\n\n'),
};

brief.addEventListener('input', () => brief.setCustomValidity(''));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = brief.value.trim();
  if (!text) {
    brief.setCustomValidity('Brif matnini yozing.');
    brief.reportValidity();
    return;
  }

  const format = new FormData(form).get('format');
  draft.value = draftTemplates[format](text);
  emptyState.hidden = true;
  draft.hidden = false;
  copyButton.disabled = false;
  status.textContent = 'Qoralama tayyor.';
  draft.focus();
  draft.setSelectionRange(0, 0);
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
