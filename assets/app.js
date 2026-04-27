(() => {
  'use strict';

  // Worker endpoint — bound via wrangler.jsonc routes.
  const ENDPOINT = 'https://forms.wolfmind.io';

  // ── Interest chips on the §05 form ────────────────────────────────
  const chipsRoot = document.querySelector('[data-interest-chips]');
  const interestInput = document.querySelector('input[name="interest"]');

  function selectedChips() {
    return Array.from(chipsRoot.querySelectorAll('.chip[aria-pressed="true"]'))
      .map((b) => b.dataset.value);
  }

  function syncInterest() {
    interestInput.value = selectedChips().join(',');
  }

  function toggleChip(btn) {
    const on = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', on ? 'false' : 'true');
    syncInterest();
  }

  if (chipsRoot) {
    chipsRoot.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (btn) toggleChip(btn);
    });
    chipsRoot.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      const btn = e.target.closest('.chip');
      if (!btn) return;
      e.preventDefault();
      toggleChip(btn);
    });
    syncInterest();
  }

  // ── Pre-select interest when arriving from a product-row button ────
  document.querySelectorAll('a[data-preselect]').forEach((link) => {
    link.addEventListener('click', () => {
      const value = link.dataset.preselect;
      chipsRoot.querySelectorAll('.chip').forEach((chip) => {
        chip.setAttribute('aria-pressed', chip.dataset.value === value ? 'true' : 'false');
      });
      syncInterest();
    });
  });

  // ── Keep-me-posted modal ──────────────────────────────────────────
  const keepPostedDialog = document.getElementById('updates-dialog');
  const keepPostedForm = document.getElementById('keep-posted-form');

  function openUpdates({ product } = {}) {
    if (typeof keepPostedDialog.showModal === 'function') {
      keepPostedDialog.showModal();
    } else {
      keepPostedDialog.setAttribute('open', '');
    }
    keepPostedForm.querySelectorAll('input[name="product"]').forEach((cb) => {
      cb.checked = product ? cb.value === product : false;
    });
    setTimeout(() => keepPostedForm.querySelector('input[name="email"]').focus(), 50);
  }

  function closeUpdates() {
    if (typeof keepPostedDialog.close === 'function') keepPostedDialog.close();
    else keepPostedDialog.removeAttribute('open');
  }

  document.querySelectorAll('[data-open-updates]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openUpdates({ product: el.dataset.product });
    });
  });

  document.querySelectorAll('[data-close-updates]').forEach((el) => {
    el.addEventListener('click', closeUpdates);
  });

  // Click outside dialog content (on backdrop) closes it
  keepPostedDialog.addEventListener('click', (e) => {
    if (e.target === keepPostedDialog) closeUpdates();
  });

  // ── Form submission ──────────────────────────────────────────────
  function status(form, msg, kind) {
    const el = form.querySelector('.form__status');
    el.textContent = msg;
    el.classList.remove('form__status--ok', 'form__status--err');
    if (kind) el.classList.add(`form__status--${kind}`);
  }

  async function postJSON(path, payload) {
    const res = await fetch(ENDPOINT + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = (body && body.error) || `Request failed (${res.status})`;
      throw new Error(err);
    }
    return body;
  }

  function submitting(form, on) {
    const btn = form.querySelector('.form__submit');
    btn.disabled = on;
    btn.querySelector('span').textContent = on
      ? 'Submitting…'
      : (form.id === 'design-partner-form' ? 'Apply to design-partner cohort' : 'Subscribe');
  }

  // §05 design-partner form ─────────────────────────────────────────
  const dpForm = document.getElementById('design-partner-form');
  dpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(dpForm);
    const payload = {
      company: (data.get('company') || '').trim(),
      role: (data.get('role') || '').trim(),
      name: (data.get('name') || '').trim(),
      email: (data.get('email') || '').trim(),
      interest: selectedChips(),
      notes: (data.get('notes') || '').trim(),
      page: location.href,
    };
    if (!payload.email || !payload.email.includes('@')) {
      status(dpForm, 'A valid email is required.', 'err');
      dpForm.querySelector('#dp-email').focus();
      return;
    }
    if (!payload.company) {
      status(dpForm, 'Company is required.', 'err');
      dpForm.querySelector('#dp-company').focus();
      return;
    }
    submitting(dpForm, true);
    status(dpForm, '');
    try {
      await postJSON('/design-partner', payload);
      dpForm.reset();
      // Reset chips to default
      chipsRoot.querySelectorAll('.chip').forEach((c, i) => {
        c.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      });
      syncInterest();
      status(dpForm, 'Received. We will be in touch shortly.', 'ok');
    } catch (err) {
      status(dpForm, err.message || 'Something went wrong. Email justin@wolfmind.io.', 'err');
    } finally {
      submitting(dpForm, false);
    }
  });

  // Keep-me-posted form ────────────────────────────────────────────
  keepPostedForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(keepPostedForm);
    const products = data.getAll('product');
    const payload = {
      email: (data.get('email') || '').trim(),
      products,
      page: location.href,
    };
    if (!payload.email || !payload.email.includes('@')) {
      status(keepPostedForm, 'A valid email is required.', 'err');
      keepPostedForm.querySelector('input[name="email"]').focus();
      return;
    }
    submitting(keepPostedForm, true);
    status(keepPostedForm, '');
    try {
      await postJSON('/keep-posted', payload);
      keepPostedForm.reset();
      status(keepPostedForm, 'Subscribed. Thanks.', 'ok');
      setTimeout(closeUpdates, 1400);
    } catch (err) {
      status(keepPostedForm, err.message || 'Something went wrong. Email justin@wolfmind.io.', 'err');
    } finally {
      submitting(keepPostedForm, false);
    }
  });
})();
