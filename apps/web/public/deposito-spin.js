(() => {
  const get = id => document.getElementById(id);
  const token = location.hash.slice(1);
  async function load() {
    get('retry').hidden = true;
    if (!token) {
      get('status').textContent = 'Abre la ficha desde el mensaje de tu pedido.';
      return;
    }
    get('status').textContent = 'Consultando tu ficha…';
    try {
      const response = await fetch('/v2/customer/spin-deposit', {
        method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token})
      });
      if (response.status === 404) {
        get('status').textContent = 'Esta ficha ya no está disponible. Consulta tu pedido en el chat.';
        return;
      }
      if (!response.ok) throw Error('FICHA_NO_DISPONIBLE');
      const {spin, spei, product_name: product} = await response.json();
      if (!/^\d{16}$/.test(spin?.card_number) || !spin.holder?.trim() ||
          (spei && (!/^\d{18}$/.test(spei.clabe) || !spei.holder?.trim() || !spei.bank?.trim()))) throw Error('FICHA_INCOMPLETA');
      get('product').textContent = product || '';
      const sharedHolder = !spei || spin.holder.trim().localeCompare(spei.holder.trim(), 'es', {sensitivity:'base'}) === 0;
      get('recipient').hidden = !sharedHolder;
      get('holder').textContent = sharedHolder ? (spei || spin).holder : '';
      get('spin-holder').textContent = sharedHolder ? '' : 'A nombre de ' + spin.holder;
      get('card').value = spin.card_number;
      if (spei) {
        const bank = spei.bank.trim();
        get('bank').textContent = /^finco\s*pay$/i.test(bank) ? bank + ' (ARQ)' : bank;
        get('spei-holder').textContent = sharedHolder ? '' : 'Beneficiaria: ' + spei.holder;
        get('clabe').value = spei.clabe;
        get('spei').hidden = false;
      }
      get('state').hidden = true;
      get('details').hidden = false;
    } catch {
      get('status').textContent = 'No pudimos consultar tu ficha. Intenta de nuevo.';
      get('retry').hidden = false;
    }
  }
  async function copy(button) {
    const field = get(button.dataset.copy);
    let copied = false;
    try {
      await navigator.clipboard.writeText(field.value);
      copied = true;
    } catch {
      field.focus();
      field.select();
      field.setSelectionRange(0, field.value.length);
      try { copied = document.execCommand('copy'); } catch { /* La selección queda disponible. */ }
    }
    get('feedback').textContent = copied
      ? (field.id === 'clabe' ? 'CLABE copiada.' : 'Número de tarjeta copiado.')
      : 'Seleccionamos el número. Toca Copiar en tu dispositivo.';
  }
  for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', () => copy(button));
  get('retry').addEventListener('click', load);
  load();
})();
