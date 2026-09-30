import { ApiBuilder } from '../core/router';
import { arrayParam, sendCreated, sendList, sendNoContent } from '../core/http';
import { conflict, unprocessable } from '../core/errors';
import { nowIso } from '../core/dates';
import { db } from '../domain/repo';
import { isCountryCode } from '../domain/reference';
import type { Account } from '../domain/types';

/**
 * Account API - the tenant this installation represents. A real apaleo
 * account is created through their onboarding; here the current account is
 * created on first read so the endpoint is never empty.
 */

const api = new ApiBuilder('account-v1');

const CURRENT = 'CURRENT';

function currentAccount(): Account {
  const existing = db.accounts.get(CURRENT);
  if (existing) return existing;
  const created: Account = {
    id: CURRENT,
    code: process.env.APALEO_ACCOUNT_CODE ?? 'LOCAL',
    name: process.env.APALEO_ACCOUNT_NAME ?? 'Local apaleo clone',
    created: nowIso(),
    subscriptionPlan: 'Development',
  };
  db.accounts.put(created);
  return created;
}

function accountBody(a: Account) {
  return {
    code: a.code,
    name: a.name,
    description: a.description,
    defaultLanguage: a.defaultLanguage ?? 'en',
    logoUrl: a.logoUrl,
    location: a.location,
    type: a.type ?? 'Development',
    additionallySupportedCountries: a.additionallySupportedCountries,
  };
}

api.op('AccountAccountsCurrentGet', (_req, res) => {
  res.json(accountBody(currentAccount()));
});

api.op('AccountAccountsCurrentPut', (req, res) => {
  const account = currentAccount();
  const body = req.body as Record<string, any>;
  account.name = body.name;
  account.description = body.description;
  account.logoUrl = body.logoUrl;
  if (body.location) {
    account.location = { ...body.location, countryCode: String(body.location.countryCode).toUpperCase() };
  }
  if (body.additionallySupportedCountries) {
    for (const code of body.additionallySupportedCountries) {
      if (!isCountryCode(code)) throw unprocessable(`'${code}' is not a valid ISO 3166-1 alpha-2 country code.`);
    }
    account.additionallySupportedCountries = body.additionallySupportedCountries.map((c: string) => c.toUpperCase());
  }
  db.accounts.put(account);
  sendNoContent(res);
});

api.op('AccountAccountsGet', (req, res) => {
  const codes = arrayParam(req, 'accountCodes');
  currentAccount();
  const accounts = db.accounts.all().filter((a) => !codes.length || codes.includes(a.code));
  sendList(res, 'accounts', accounts.map((a) => ({
    code: a.code,
    name: a.name,
    description: a.description,
    type: a.type ?? 'Development',
  })), accounts.length);
});

api.op('AccountAccountsPost', (req, res) => {
  const body = req.body as Record<string, any>;
  const code = String(body.code ?? body.name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (!code) throw unprocessable('`code` must contain at least one alphanumeric character.');
  if (db.accounts.all().some((a) => a.code === code)) {
    throw conflict(`An account with code '${code}' already exists.`);
  }
  const account: Account = {
    id: code,
    code,
    name: body.name,
    description: body.description,
    defaultLanguage: body.defaultLanguage,
    logoUrl: body.logoUrl,
    location: body.location
      ? { ...body.location, countryCode: String(body.location.countryCode).toUpperCase() }
      : undefined,
    type: body.type,
    created: nowIso(),
    subscriptionPlan: body.type ?? 'Trial',
  };
  db.accounts.put(account);
  sendCreated(res, `/account/v1/accounts/${code}`, { code });
});

api.op('AccountAccount-actionsCurrentSuspendPut', (_req, res) => {
  const account = currentAccount();
  if (account.type === 'Suspended') throw unprocessable('The account is already suspended.');
  account.type = 'Suspended';
  db.accounts.put(account);
  sendNoContent(res);
});

api.op('AccountAccount-actionsCurrentSet-livePut', (_req, res) => {
  const account = currentAccount();
  if (account.type === 'Live') throw unprocessable('The account is already live.');
  if (db.properties.count() === 0) {
    throw unprocessable('The account has no properties and cannot be set live.');
  }
  account.type = 'Live';
  db.accounts.put(account);
  sendNoContent(res);
});

export const accountRouter = api.build();
