(function () {
  const form = document.getElementById('post-form');
  const text = document.getElementById('text-input');
  const options = document.getElementById('options-input');
  const image = document.getElementById('image-input');
  const pvText = document.getElementById('pv-text');
  const pvImage = document.getElementById('pv-image');
  const pvPoll = document.getElementById('pv-poll');

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
    form.dataset.type = t;
    document.querySelectorAll('.label-text').forEach((el) => (el.textContent = el.dataset[t]));
    pvText.innerHTML = format(text.value) || '<span class="muted">Tu publicación</span>';
    pvText.classList.toggle('poll-question', t === 'poll');
    pvImage.hidden = t !== 'image' || !pvImage.getAttribute('src');
    pvPoll.innerHTML = '';
    if (t === 'poll') {
      options.value.split('\n').map((s) => s.trim()).filter(Boolean).forEach((o) => {
        const li = document.createElement('li');
        li.textContent = o;
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
