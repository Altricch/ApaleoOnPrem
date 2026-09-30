import { h, field, input, toast } from '../dom.js';
import { api, ApiError } from '../api.js';

/**
 * Sign-in. The clone authenticates with OAuth2 client credentials, so that
 * is what the form collects - prefilled with the defaults the server ships
 * with, which is what makes this usable straight out of the box.
 */
export function loginView(onSignedIn) {
  const clientId = input({ value: 'apaleo-clone', autocomplete: 'username', spellcheck: 'false' });
  const clientSecret = input({ type: 'password', value: 'secret', autocomplete: 'current-password' });
  const error = h('div.warnings', { style: { display: 'none' } });
  const submit = h('button.btn.primary.block', { type: 'submit' }, 'Sign in');

  async function signIn(event) {
    event.preventDefault();
    error.style.display = 'none';
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      await api.signIn(clientId.value.trim(), clientSecret.value);
      await onSignedIn();
    } catch (err) {
      error.textContent = err instanceof ApiError ? err.messages.join(' ') : String(err);
      error.style.display = '';
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  }

  async function continueAnonymously() {
    try {
      await onSignedIn();
    } catch {
      toast('Anonymous access is disabled', 'Sign in with the client credentials above.', 'bad');
    }
  }

  return h('div.login', [
    h('div.login-card', [
      h('div.login-brand', [
        h('div.glyph', 'a'),
        h('div', [
          h('h1', 'apaleo clone'),
          h('p', 'Property management system'),
        ]),
      ]),
      h('form', { onsubmit: signIn }, [
        error,
        field('Client ID', clientId),
        field('Client secret', clientSecret),
        submit,
        h('p.hint', [
          'Default credentials are prefilled: ',
          h('strong', 'apaleo-clone'), ' / ', h('strong', 'secret'),
          '. Change them with the ', h('code', 'APALEO_CLIENT_ID'), ' and ',
          h('code', 'APALEO_CLIENT_SECRET'), ' environment variables.',
        ]),
      ]),
      h('p.alt', [
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); continueAnonymously(); } },
          'Continue without signing in'),
        ' · ',
        h('a', { href: '/docs/', target: '_blank' }, 'API explorer'),
      ]),
    ]),
  ]);
}
