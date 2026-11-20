(() => {
  const token = location.hash.slice(1);
  const button = document.getElementById('show');
  const status = document.getElementById('status');
  if (!token) {
    button.hidden = true;
    status.textContent = 'Abre la ficha desde el enlace de tu pedido.';
    return;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Consultando datos…';
    try {
      const response = await fetch('/v2/customer/spin-deposit', {
        method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token})
      });
      if (response.status === 404) {
        button.hidden = true;
        status.textContent = 'Esta ficha ya no está disponible. Consulta tu pedido en el chat.';
        return;
      }
      if (!response.ok) throw Error();
      const {spin, spei} = await response.json();
      document.getElementById('card').textContent = spin.card_number.match(/.{1,4}/g).join(' ');
      document.getElementById('holder').textContent = spin.holder;
      if (spei) {
        document.getElementById('bank').textContent = spei.bank;
        document.getElementById('clabe').textContent = spei.clabe;
        document.getElementById('beneficiary').textContent = spei.holder;
        document.getElementById('spei').hidden = false;
      }
      document.getElementById('details').hidden = false;
      button.hidden = true;
      status.textContent = 'Datos del pedido disponibles.';
    } catch {
      status.textContent = 'No pudimos consultar tu ficha. Intenta de nuevo.';
      button.disabled = false;
    }
  });
})();
