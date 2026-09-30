import { Router, urlencoded } from 'express';
import { config } from './config';
import { authenticateClient, issueToken, listClients } from './auth';

/**
 * A minimal stand-in for `identity.apaleo.com`. It speaks enough OpenID
 * Connect discovery and OAuth2 for the apaleo SDKs, Postman and curl to
 * obtain a token without any of the real identity server's ceremony.
 */
export function identityRouter(): Router {
  const router = Router();
  router.use(urlencoded({ extended: false }));

  router.get('/.well-known/openid-configuration', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      issuer: base,
      token_endpoint: `${base}/connect/token`,
      authorization_endpoint: `${base}/connect/authorize`,
      jwks_uri: `${base}/.well-known/jwks`,
      grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
      response_types_supported: ['code', 'token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: ['admin', 'openid', 'profile'],
    });
  });

  // We sign with a shared secret rather than RSA, so there are no public keys
  // to publish; the endpoint exists so discovery clients do not 404.
  router.get('/.well-known/jwks', (_req, res) => res.json({ keys: [] }));

  router.post('/connect/token', (req, res) => {
    const body = req.body as Record<string, string>;
    const grantType = body.grant_type;
    if (grantType !== 'client_credentials') {
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: `This clone only implements 'client_credentials'; got '${grantType ?? 'nothing'}'.`,
      });
    }

    // Credentials may arrive as Basic auth or as form fields.
    let clientId = body.client_id;
    let clientSecret = body.client_secret;
    const auth = req.get('authorization');
    if (auth?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      clientId = decodeURIComponent(decoded.slice(0, idx));
      clientSecret = decodeURIComponent(decoded.slice(idx + 1));
    }
    if (!clientId) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required.' });
    }

    const client = authenticateClient(clientId, clientSecret ?? '');
    if (!client) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client or bad secret.' });
    }

    const requested = body.scope ? body.scope.split(' ').filter(Boolean) : undefined;
    try {
      return res.json(issueToken(client, requested));
    } catch {
      return res.status(400).json({ error: 'invalid_scope', error_description: 'The client may not request those scopes.' });
    }
  });

  /**
   * The implicit/authorization-code endpoint the Swagger UI links to. There is
   * no login here - any request is approved - because the point is to let the
   * docs page drive the local API, not to model a login.
   */
  router.get('/connect/authorize', (req, res) => {
    const { redirect_uri: redirectUri, state, client_id: clientId, response_type: responseType } = req.query as Record<string, string>;
    const client = listClients().find((c) => c.clientId === clientId) ?? listClients()[0]!;
    const token = issueToken(client, req.query.scope ? String(req.query.scope).split(' ') : undefined);
    if (!redirectUri) {
      return res.json(token);
    }
    const fragment = new URLSearchParams({
      access_token: token.access_token,
      token_type: token.token_type,
      expires_in: String(token.expires_in),
      scope: token.scope,
      ...(state ? { state } : {}),
    });
    const separator = responseType === 'code' ? '?' : '#';
    return res.redirect(`${redirectUri}${separator}${fragment.toString()}`);
  });

  /** Convenience for local work: hand out a ready-to-use admin token. */
  router.get('/connect/dev-token', (_req, res) => {
    res.json({
      ...issueToken(listClients()[0]!),
      note: `Use as: Authorization: Bearer <access_token>. Anonymous access is ${config.allowAnonymous ? 'enabled' : 'disabled'}.`,
    });
  });

  return router;
}
