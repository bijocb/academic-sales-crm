import type { Response } from 'express';
import type { IssuedTokens } from './auth.service';

export const ACCESS_COOKIE = 'crm_at';
export const REFRESH_COOKIE = 'crm_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function setAuthCookies(res: Response, tokens: IssuedTokens, secure: boolean): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: tokens.accessTokenExpiresAt,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires: tokens.refreshTokenExpiresAt,
  });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  res.clearCookie(ACCESS_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}
