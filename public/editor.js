(function () {
  const form = document.getElementById('post-form');
  const text = document.getElementById('text-input');
  const options = document.getElementById('options-input');
  const image = document.getElementById('image-input');
  const pvText = document.getElementById('pv-text');
  const pvImage = document.getElementById('pv-image');
  const pvPoll = document.getElementById('pv-poll');
  const correct = document.getElementById('correct-input');

  const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  // Aproximación del formato de WhatsApp para la vista previa.
  const format = (s) =>
    escape(s)
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
      .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<i>$2</i>')
      .replace(/~([^~\n]+)~/g, '<s>$1</s>')
      .replace(/\n/g, '<br>');

  function type() {
    return form.querySelector('input[name=type]:checked')?.value || 'text';
  }

  function render() {
    const t = type();
    const kind = form.querySelector('input[name=poll_kind]:checked')?.value || 'poll';
    form.dataset.type = t;
    form.dataset.kind = t === 'poll' ? kind : '';
    const opts = options.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const current = correct.value || correct.dataset.selected;
    correct.innerHTML = '<option value="">Elegí la correcta</option>';
    opts.forEach((o) => {
      const el = document.createElement('option');
      el.value = el.textContent = o;
      if (o === current) el.selected = true;
      correct.appendChild(el);
    });
    document.querySelectorAll('.label-text').forEach((el) => (el.textContent = el.dataset[t]));
    pvText.innerHTML = format(text.value) || '<span class="muted">Tu publicación</span>';
    pvText.classList.toggle('poll-question', t === 'poll');
    const removeImage = form.querySelector('input[name=remove_image]')?.checked;
    pvImage.hidden = t === 'text' || removeImage || !pvImage.getAttribute('src');
    pvPoll.innerHTML = '';
    if (t === 'poll') {
      opts.forEach((o) => {
        const li = document.createElement('li');
        li.textContent = o;
        if (kind === 'quiz' && o === correct.value) li.className = 'correct';
        pvPoll.appendChild(li);
      });
    }
  }

  image.addEventListener('change', () => {
    const f = image.files[0];
    if (f) pvImage.src = URL.createObjectURL(f);
    render();
  });
  form.addEventListener('input', render);
  form.addEventListener('change', render);
  render();
})();
